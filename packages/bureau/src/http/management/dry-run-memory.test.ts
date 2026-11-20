/**
 * COR-2522 — `bureau.memory.forget` and `bureau.memory.embedding.cancel` with `dryRun: true`.
 *
 * A memory that refuses a deletion records an event of its own, `memory.access.denied`, and every
 * read of a record records a read; the dry run uses neither, so the ledger it leaves is the ledger
 * it found.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import {
  createGovernedMemory,
  createInMemoryMemoryRecordStorage,
  createMemoryGovernanceLedger,
  createMemoryGovernancePolicy,
  createMemoryVectorStore,
  createMockEmbedder,
  createTestEmbedders,
  type GovernedMemory,
} from '@lostgradient/memory';
import { type AuthConfig, principalFromApiKey } from '@lostgradient/backchannel';
import { createAgent, type GenerateFunction } from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';

import { waitForTaskState } from '../../test';
import {
  dryRunResultOf,
  expectNothingWritten,
  expectSameFaultAsTheRealCall,
  settledSnapshot,
  withBureau,
} from './dry-run.test-support.ts';
import { rpc } from './management-fixtures.test-support.ts';

const BUREAU_ID = 'management-bureau';

/** Alice and Bob each read and write memory; the settings writer operates the embedding. */
const authentication: AuthConfig = {
  auditSink: () => undefined,
  resolveApiKeyPrincipal: async (key) => {
    const credentials: Record<string, { subject: string; scopes: string[] }> = {
      'alice-key': { subject: 'alice', scopes: ['bureau.memory:read', 'bureau.memory:write'] },
      'bob-key': { subject: 'bob', scopes: ['bureau.memory:read', 'bureau.memory:write'] },
      'settings-writer-key': { subject: 'operator', scopes: ['bureau.settings:write'] },
    };
    const credential = credentials[key];
    return credential === undefined
      ? null
      : principalFromApiKey({ subject: credential.subject, scopes: credential.scopes as never });
  },
};

/** An agent that answers with the fact its user message names, so each chat stores a known fact. */
function recording(): GenerateFunction {
  return async ({ conversation }) => {
    const user = conversation.getMessages().findLast((message) => message.role === 'user')?.content;
    return { content: typeof user === 'string' ? user : 'noted', toolCalls: [] };
  };
}

/** Governed memory over `durable`, whose ledger and vectors the test can read. */
function governedOver(durable: MemoryStorage): GovernedMemory {
  const runtime = createManualRuntimeServices({ identifierSeed: 'dry-run-memory' });
  return createGovernedMemory({
    storage: createInMemoryMemoryRecordStorage({ now: () => runtime.clock.now() }),
    ledger: createMemoryGovernanceLedger(durable),
    ...createTestEmbedders(createMockEmbedder(64), 64),
    vectors: createMemoryVectorStore(durable),
    policy: createMemoryGovernancePolicy({ revision: 'governance:dry-run' }),
    runtime,
  });
}

async function open<T>(
  body: (
    served: Parameters<Parameters<typeof withBureau<T>>[1]>[0] & {
      readonly memory: GovernedMemory;
    },
    subject: Parameters<Parameters<typeof withBureau<T>>[1]>[1],
  ) => Promise<T>,
): Promise<T> {
  const durable = new MemoryStorage();
  const bureauStorage = new MemoryStorage();
  const memory = governedOver(durable);
  return withBureau<T>(
    {
      id: BUREAU_ID,
      storage: bureauStorage,
      agents: { assistant: createAgent({ generate: recording() }) },
      authentication,
      bureauOptions: { memory },
    },
    (opened, subject) =>
      body(Object.assign(opened, { memory }), { ...subject, storage: [bureauStorage, durable] }),
  );
}

async function chat(
  opened: Parameters<Parameters<typeof open>[0]>[0],
  principal: string,
  message: string,
): Promise<void> {
  const run = await opened.bureau.tasks.start('assistant', message, {
    contextId: `chat-${message.slice(0, 12)}`,
    principal,
  });
  await waitForTaskState(opened.bureau, run.id);
}

/** The identifier of the one memory `key`'s owner has. */
async function onlyMemoryOf(
  opened: Parameters<Parameters<typeof open>[0]>[0],
  key: string,
): Promise<string> {
  const listed = await rpc(opened.handler, 'bureau.memory.list', { agentId: 'assistant' }, key);
  const memories = listed.result?.['memories'] as Array<{ id: string }> | undefined;
  expect(memories).toHaveLength(1);
  return memories![0]!.id;
}

describe('bureau.memory.forget with dryRun', () => {
  it('counts the one memory it would remove, writes nothing, records no event and keeps the memory', async () => {
    await open(async (opened, subject) => {
      await chat(opened, 'api-key:alice', 'Alice prefers aisle seats.');
      const id = await onlyMemoryOf(opened, 'alice-key');

      const body = await expectNothingWritten(subject, () =>
        rpc(
          opened.handler,
          'bureau.memory.forget',
          { agentId: 'assistant', id, dryRun: true },
          'alice-key',
        ),
      );

      expect(dryRunResultOf(body)).toEqual({
        dryRun: true,
        target: { kind: 'memory', id },
        // A floor: the summaries derived from the memory would go with it.
        effects: [{ kind: 'memories', count: 1, atLeast: true }],
      });
      expect(await onlyMemoryOf(opened, 'alice-key')).toBe(id);

      // The real call then forgets it, and it does write: the check above has teeth.
      const before = await settledSnapshot(subject.storage);
      const real = await rpc(
        opened.handler,
        'bureau.memory.forget',
        { agentId: 'assistant', id },
        'alice-key',
      );
      expect(real.result).toMatchObject({ id });
      expect(await settledSnapshot(subject.storage)).not.toEqual(before);
    });
  });

  it('records nothing for a memory another owner holds, which is a NotFound', async () => {
    await open(async (opened, subject) => {
      await chat(opened, 'api-key:alice', 'Alice prefers aisle seats.');
      const id = await onlyMemoryOf(opened, 'alice-key');

      // Bob is not the owner: the dry run is as plain a NotFound as the call, with nothing recorded.
      await expectNothingWritten(subject, () =>
        rpc(
          opened.handler,
          'bureau.memory.forget',
          { agentId: 'assistant', id, dryRun: true },
          'bob-key',
        ),
      );
    });
  });

  it('answers the fault the real call answers for a memory that is missing or another owner’s', async () => {
    await open(async (opened) => {
      await chat(opened, 'api-key:alice', 'Alice prefers aisle seats.');
      const id = await onlyMemoryOf(opened, 'alice-key');
      await expectSameFaultAsTheRealCall(
        opened,
        'bureau.memory.forget',
        { agentId: 'assistant', id: 'no-such-memory' },
        'alice-key',
      );
      await expectSameFaultAsTheRealCall(
        opened,
        'bureau.memory.forget',
        { agentId: 'assistant', id },
        'bob-key',
      );
    });
  });
});

describe('bureau.memory.embedding.cancel with dryRun', () => {
  it('counts the running switch it would cancel, writes nothing and leaves the switch running', async () => {
    await open(async (opened, subject) => {
      await chat(opened, 'api-key:alice', 'Alice prefers aisle seats.');
      expect(await opened.memory.embedding.switchTo('hashing')).toMatchObject({
        outcome: 'started',
      });

      const body = await expectNothingWritten(subject, () =>
        rpc(
          opened.handler,
          'bureau.memory.embedding.cancel',
          { dryRun: true },
          'settings-writer-key',
        ),
      );

      expect(dryRunResultOf(body)).toEqual({
        dryRun: true,
        target: { kind: 'memory-embedding-switch', id: 'hashing' },
        effects: [{ kind: 'running-switches', count: 1 }],
      });
      const status = await opened.memory.embedding.status();
      expect(status.job).toMatchObject({ target: 'hashing', state: 'running' });

      // The real call then cancels it.
      const real = await rpc(
        opened.handler,
        'bureau.memory.embedding.cancel',
        {},
        'settings-writer-key',
      );
      expect(real.result).toEqual({ cancelled: true });
    });
  });

  it('counts none when no switch runs', async () => {
    await open(async (opened, subject) => {
      const body = await expectNothingWritten(subject, () =>
        rpc(
          opened.handler,
          'bureau.memory.embedding.cancel',
          { dryRun: true },
          'settings-writer-key',
        ),
      );
      expect(dryRunResultOf(body)).toEqual({
        dryRun: true,
        target: { kind: 'memory-embedding-switch', id: 'none' },
        effects: [{ kind: 'running-switches', count: 0 }],
      });
    });
  });

  it('answers the fault the real call answers for a caller without the settings scope', async () => {
    await open(async (opened) => {
      await expectSameFaultAsTheRealCall(opened, 'bureau.memory.embedding.cancel', {}, 'alice-key');
    });
  });
});
