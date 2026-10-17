import {
  type ApplicationCommandClaim,
  Engine,
  Mailbox,
  MemoryStorage,
  resolveStorage,
  type Storage,
  textValueStore,
  yieldToPortableEventLoop,
} from '@lostgradient/weft';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import type { Conversation } from 'conversationalist';
import { createConversationHistory } from 'conversationalist';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { noToolCalls } from '../conditions/predicates';
import type { GenerateContext, GenerateFunction } from '../types';
import { createCheckpointStore } from './checkpoint-store';
import {
  createMailboxSessionInputGate,
  type DecodedSessionInput,
  type SessionInputPromotionStore,
} from './mailbox-session-input-gate';
import { createRunWorkflow } from './run-workflow';
import { createStorageActivities } from './storage-activities';
import type { DurableRunDeps, SessionInputGate } from './types';

/**
 * COR-1476 — session input admitted while a durable run is live reaches the run
 * at its next step boundary, in admission order, exactly once, across a restart.
 *
 * The gate under test is the real mailbox-backed one. Bureau supplies the
 * promotion store from its session store; here it is a small durable record in
 * the same backend, which is all the gate needs to know an input was delivered.
 */

const SESSION_ID = 'session-1';
const RUN_ID = 'run-session-input-1';

const nextTool = createTool({
  name: 'next',
  description: 'continue',
  input: z.object({}),
  execute: async () => 'ok',
});

afterEach(async () => {
  await yieldToPortableEventLoop();
});

function newMailbox(storage: Storage, now?: () => number): Mailbox {
  return new Mailbox({
    storage,
    namespace: 'test.session-input',
    resourceId: SESSION_ID,
    ...(now === undefined ? {} : { now }),
  });
}

function decode(claim: ApplicationCommandClaim): DecodedSessionInput {
  if (claim.payload.form !== 'inline') throw new Error('expected an inline payload');
  const value = claim.payload.value as { payload: string };
  return {
    payload: value.payload,
    deliveryMode: claim.receipt.kind === 'session-input:queue' ? 'queue' : 'steer',
  };
}

interface PromotionRecord {
  conversationMessageId: string;
  providerTurn: number;
}

function promotionStoreOver(storage: Storage): SessionInputPromotionStore & {
  read(id: string): Promise<PromotionRecord | undefined>;
} {
  const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
  const key = (id: string) => `test:session-input-promotion:${id}`;
  return {
    async isPromoted(id) {
      return (await kv.get(key(id))) !== null;
    },
    async promote(delivery) {
      const record: PromotionRecord = {
        conversationMessageId: delivery.conversationMessageId,
        providerTurn: delivery.providerTurn,
      };
      // First write wins, as the real promotion's already-promoted no-op does.
      await kv.conditionalBatch(
        [{ key: key(delivery.id), expectedValue: null }],
        [{ type: 'set', key: key(delivery.id), value: JSON.stringify(record) }],
      );
    },
    async read(id) {
      const raw = await kv.get(key(id));
      return raw === null ? undefined : (JSON.parse(raw) as PromotionRecord);
    },
  };
}

async function openCount(mailbox: Mailbox): Promise<number> {
  const capacity = await mailbox.capacity();
  return capacity.open;
}

async function admit(mailbox: Mailbox, id: string, text: string): Promise<void> {
  const admission = await mailbox.admit({
    caller: 'alice',
    target: SESSION_ID,
    kind: 'session-input:steer',
    payload: { form: 'inline', value: { payload: text } },
    idempotencyKey: id,
  });
  expect(admission.status).toBe('admitted');
}

function userTexts(conversation: Conversation): string[] {
  return conversation
    .getMessages()
    .filter((message) => message.role === 'user')
    .map((message) => (typeof message.content === 'string' ? message.content : ''));
}

function sessionInputMessages(conversation: Conversation): { id: string; messageId: string }[] {
  return conversation
    .getMessages()
    .filter((message) => typeof message.metadata?.['sessionInputId'] === 'string')
    .map((message) => ({
      id: message.metadata?.['sessionInputId'] as string,
      messageId: message.id,
    }));
}

function makeServices(generate: GenerateFunction, gate: SessionInputGate): DurableRunDeps {
  const toolbox = createToolbox([nextTool]);
  return {
    toolbox,
    options: {
      generate,
      toolbox,
      conversation: createConversationHistory(),
      stopWhen: noToolCalls(),
      sessionInput: gate,
    },
  };
}

async function buildEngine(storage: Storage, resolveServices?: () => DurableRunDeps) {
  const checkpointStore = createCheckpointStore(
    textValueStore(storage, { disposeUnderlyingStorage: false }),
  );
  const activities = createStorageActivities(checkpointStore);
  return Engine.create({
    storage,
    recover: false,
    ...(resolveServices === undefined
      ? {}
      : {
          resolveWorkflowServices: () => ({
            status: 'available' as const,
            services: resolveServices(),
          }),
        }),
    workflows: { agentRun: createRunWorkflow(checkpointStore) },
    activities: {
      saveCursor: activities.saveCursor,
      saveConversation: activities.saveConversation,
      recordStep: activities.recordStep,
    },
  });
}

type TestEngine = Awaited<ReturnType<typeof buildEngine>>;

function startRun(engine: TestEngine, services: DurableRunDeps) {
  return engine.start(
    'agentRun',
    { runId: RUN_ID, sessionId: SESSION_ID, agentName: '', prompt: 'Start' },
    { id: RUN_ID, services },
  );
}

function deferred<T = void>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: release };
}

describe('session input at the durable step boundary (COR-1476)', () => {
  it('shows input admitted during a step to the model on the next step', async () => {
    const storage = new MemoryStorage();
    const mailbox = newMailbox(storage);
    const promotion = promotionStoreOver(storage);
    const gate = createMailboxSessionInputGate({ mailbox, decode, promotion });
    const stepZeroStarted = deferred();
    const releaseStepZero = deferred();
    const prompts: string[][] = [];

    const engine = await buildEngine(storage);
    try {
      const handle = await startRun(
        engine,
        makeServices(async (context: GenerateContext) => {
          prompts.push(userTexts(context.conversation));
          if (context.step === 0) {
            stepZeroStarted.resolve();
            await releaseStepZero.promise;
            return { content: 'working', toolCalls: [{ name: 'next', arguments: {} }] };
          }
          return { content: 'done', toolCalls: [] };
        }, gate),
      );
      await stepZeroStarted.promise;
      await admit(mailbox, 'input-a', 'also check the tests');
      releaseStepZero.resolve();
      const result = (await handle.result()) as { steps: number };

      expect(result.steps).toBe(2);
      expect(prompts[0]).toEqual(['Start']);
      expect(prompts[1]).toEqual(['Start', 'also check the tests']);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('delivers two inputs in admission order, once each, and promotes them', async () => {
    const storage = new MemoryStorage();
    const mailbox = newMailbox(storage);
    const promotion = promotionStoreOver(storage);
    const gate = createMailboxSessionInputGate({ mailbox, decode, promotion });
    const stepZeroStarted = deferred();
    const releaseStepZero = deferred();
    const prompts: string[][] = [];
    const seen: Conversation[] = [];

    const engine = await buildEngine(storage);
    try {
      const handle = await startRun(
        engine,
        makeServices(async (context: GenerateContext) => {
          prompts.push(userTexts(context.conversation));
          seen.push(context.conversation);
          if (context.step === 0) {
            stepZeroStarted.resolve();
            await releaseStepZero.promise;
            return { content: 'working', toolCalls: [{ name: 'next', arguments: {} }] };
          }
          if (context.step === 1) {
            return { content: 'still going', toolCalls: [{ name: 'next', arguments: {} }] };
          }
          return { content: 'done', toolCalls: [] };
        }, gate),
      );
      await stepZeroStarted.promise;
      await admit(mailbox, 'input-a', 'first');
      await admit(mailbox, 'input-b', 'second');
      releaseStepZero.resolve();
      await handle.result();

      expect(prompts[0]).toEqual(['Start']);
      expect(prompts[1]).toEqual(['Start', 'first', 'second']);
      // Delivered at step 1's boundary only; step 2 does not see them again.
      expect(prompts[2]).toEqual(['Start', 'first', 'second']);

      const delivered = sessionInputMessages(seen[2]!);
      expect(delivered).toHaveLength(2);
      expect(delivered.map(({ id }) => id)).toEqual(['input-a', 'input-b']);
      for (const { id, messageId } of delivered) {
        expect(await promotion.read(id)).toEqual({
          conversationMessageId: messageId,
          providerTurn: 1,
        });
      }
      expect(await openCount(mailbox)).toBe(0);
    } finally {
      engine[Symbol.dispose]();
    }
  });

  it('delivers nothing to a run that has no session input gate', async () => {
    const storage = new MemoryStorage();
    const mailbox = newMailbox(storage);
    await admit(mailbox, 'input-a', 'ignored');
    const engine = await buildEngine(storage);
    try {
      const toolbox = createToolbox([nextTool]);
      const prompts: string[][] = [];
      const handle = await startRun(engine, {
        toolbox,
        options: {
          generate: async (context: GenerateContext) => {
            prompts.push(userTexts(context.conversation));
            return { content: 'done', toolCalls: [] };
          },
          toolbox,
          conversation: createConversationHistory(),
          stopWhen: noToolCalls(),
        },
      });
      await handle.result();
      expect(prompts).toEqual([['Start']]);
      expect(await openCount(mailbox)).toBe(1);
    } finally {
      engine[Symbol.dispose]();
    }
  });
});

describe('session input gate ordering and recovery (COR-1476)', () => {
  it('returns nothing while an earlier input is still leased, so a later one never overtakes it', async () => {
    const storage = new MemoryStorage();
    const mailbox = newMailbox(storage);
    const gate = createMailboxSessionInputGate({
      mailbox,
      decode,
      promotion: promotionStoreOver(storage),
    });
    await admit(mailbox, 'input-a', 'first');

    const firstBoundary = await gate.claimPending();
    expect(firstBoundary.map(({ id }) => id)).toEqual(['input-a']);

    // A is leased and unsettled (its step has not finished); B arrives.
    await admit(mailbox, 'input-b', 'second');
    expect(await gate.claimPending()).toEqual([]);
  });

  it('reports an input delivered before a crash as settle-only once its lease lapses', async () => {
    const storage = new MemoryStorage();
    let now = 1_000_000;
    const promotion = promotionStoreOver(storage);
    const before = createMailboxSessionInputGate({
      mailbox: newMailbox(storage, () => now),
      decode,
      promotion,
    });
    const mailbox = newMailbox(storage, () => now);
    await admit(mailbox, 'input-a', 'first');
    await admit(mailbox, 'input-b', 'second');

    const firstClaims = await before.claimPending();
    expect(firstClaims.map(({ id, delivered }) => [id, delivered])).toEqual([
      ['input-a', false],
      ['input-b', false],
    ]);
    // The step committed with both in the conversation and A was promoted, then
    // the process died before settling B or acknowledging either lease.
    await promotion.promote({
      id: 'input-a',
      conversationMessageId: 'message-a',
      providerTurn: 3,
    });

    // A new process. Its leases are not lapsed yet: nothing is delivered.
    const after = createMailboxSessionInputGate({
      mailbox: newMailbox(storage, () => now),
      decode,
      promotion,
    });
    expect(await after.claimPending()).toEqual([]);

    // Past the 30 second visibility timeout the commands are released in order,
    // and each waits out the mailbox's one second retry backoff before it is due.
    now += 31_000;
    expect(await after.claimPending()).toEqual([]);
    now += 2_000;
    const healed = await after.claimPending();
    expect(healed.map(({ id, delivered }) => [id, delivered])).toEqual([
      ['input-a', true],
      ['input-b', false],
    ]);

    await after.settle([
      { id: 'input-a', providerTurn: 4 },
      { id: 'input-b', conversationMessageId: 'message-b', providerTurn: 4 },
    ]);
    expect(await openCount(mailbox)).toBe(0);
    expect(await promotion.read('input-a')).toEqual({
      conversationMessageId: 'message-a',
      providerTurn: 3,
    });
  });
});

type StorageKind = 'sqlite' | 'lmdb';

describe.each<StorageKind>(['sqlite', 'lmdb'])(
  'session input across a restart on %s (COR-1476)',
  (kind) => {
    let directory: string | undefined;
    afterEach(async () => {
      if (directory !== undefined) await rm(directory, { recursive: true, force: true });
      directory = undefined;
    });

    it('delivers inputs admitted before a crash in order, exactly once, after recovery', async () => {
      directory = await mkdtemp(join(tmpdir(), `corvidae-session-input-${kind}-`));
      const configuration =
        kind === 'sqlite'
          ? ({ type: 'sqlite', path: join(directory, 'weft.sqlite') } as const)
          : ({ type: 'lmdb', path: join(directory, 'weft-lmdb') } as const);

      // Engine A: step 0 commits, step 1 starts and hangs. While it hangs, two
      // inputs are admitted, then the process "crashes".
      const storageA = await resolveStorage(configuration);
      const mailboxA = newMailbox(storageA);
      const stepOneStarted = deferred();
      const engineA = await buildEngine(storageA);
      const handleA = await startRun(
        engineA,
        makeServices(
          async (context: GenerateContext) => {
            if (context.step === 0) {
              return { content: 'step 0', toolCalls: [{ name: 'next', arguments: {} }] };
            }
            stepOneStarted.resolve();
            return new Promise<never>(() => {});
          },
          createMailboxSessionInputGate({
            mailbox: mailboxA,
            decode,
            promotion: promotionStoreOver(storageA),
          }),
        ),
      );
      void handleA.result().catch(() => {});
      await stepOneStarted.promise;
      await admit(mailboxA, 'input-a', 'first');
      await admit(mailboxA, 'input-b', 'second');
      engineA[Symbol.dispose]();
      mailboxA.dispose();
      storageA[Symbol.dispose]();

      // Engine B: a fresh process on the same backend recovers the run.
      const storageB = await resolveStorage(configuration);
      const mailboxB = newMailbox(storageB);
      const promotion = promotionStoreOver(storageB);
      const generatedPrompts: { step: number; conversation: Conversation }[] = [];
      const engineB = await buildEngine(storageB, () =>
        makeServices(
          async (context: GenerateContext) => {
            generatedPrompts.push({ step: context.step, conversation: context.conversation });
            return { content: 'recovered', toolCalls: [] };
          },
          createMailboxSessionInputGate({ mailbox: mailboxB, decode, promotion }),
        ),
      );
      try {
        const handles = await engineB.recoverAll();
        expect(handles).toHaveLength(1);
        const result = (await handles[0]!.result()) as { steps: number; finishReason: string };

        expect(result.steps).toBe(2);
        expect(generatedPrompts.map(({ step }) => step)).toEqual([1]);
        const conversation = generatedPrompts[0]!.conversation;
        expect(userTexts(conversation)).toEqual(['Start', 'first', 'second']);

        const delivered = sessionInputMessages(conversation);
        expect(delivered.map(({ id }) => id)).toEqual(['input-a', 'input-b']);
        for (const { id, messageId } of delivered) {
          expect(await promotion.read(id)).toEqual({
            conversationMessageId: messageId,
            providerTurn: 1,
          });
        }
        expect(await openCount(mailboxB)).toBe(0);
      } finally {
        engineB[Symbol.dispose]();
        mailboxB.dispose();
        storageB[Symbol.dispose]();
      }
    });
  },
);
