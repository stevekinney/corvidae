/**
 * COR-1936 — a chat's permission mode, set over HTTP with `bureau.contexts.steer`'s
 * `permissionMode`: it is read back by `bureau.contexts.get`, it is in force for the calls decided
 * after the steer (a live run's next step, and every later run of the chat), it survives a restart
 * and a branch, and it never lets `allow-all` past a tool set to `always` or `blocked`. The
 * precedence itself is the table in `tool-approval-permission-mode.test.ts`.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MemoryStorage } from '@lostgradient/storage';
import { createTool } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createBureauHandler } from './http/create-bureau-handler';
import {
  authentication,
  rpc,
  OWNER,
  type RpcBody,
} from './http/management/management-fixtures.test-support';
import { agentFileDirectory } from './sources/agent-file-directory';
import {
  type FileBureauHarness,
  type ScriptedReply,
  startFileBureau,
} from './testing/agent-file-bureau.test-support';
import { agentFileText, KNOWN_MODEL } from './testing/agent-file-fixtures.test-support';
import type { Bureau } from './types';

const executed: string[] = [];

const tool = (name: string, metadata: { readOnly: true } | { mutates: true }) =>
  createTool({
    name,
    version: '1.0.0',
    description: name,
    input: z.object({ orderId: z.string() }),
    metadata,
    execute: async ({ orderId }) => {
      executed.push(`${name}:${orderId}`);
      return { ok: orderId };
    },
  });

const TOOLS = {
  'read-order': tool('read-order', { readOnly: true }),
  'issue-refund': tool('issue-refund', { mutates: true }),
};

const roots: string[] = [];
const harnesses: FileBureauHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  executed.length = 0;
});

/** What the model answers on its next step, in order; an empty queue answers `Done.`. */
const steps: Array<() => ScriptedReply | Promise<ScriptedReply>> = [];

const call = (name: string, orderId: string): ScriptedReply => ({
  content: '',
  toolCalls: [{ name, arguments: { orderId } }],
});

interface Opened {
  readonly harness: FileBureauHarness;
  readonly bureau: Bureau;
  readonly steer: (contextId: string, commandId: string, params: object) => Promise<RpcBody>;
  readonly settled: (contextId: string) => Promise<Record<string, unknown> | undefined>;
}

async function open(
  toolApproval?: string,
  shared?: { readonly directory: string; readonly storage: MemoryStorage },
): Promise<Opened> {
  const directory = shared?.directory ?? (await mkdtemp(join(tmpdir(), 'bureau-permission-mode-')));
  if (shared === undefined) roots.push(directory);
  const harness = await startFileBureau({
    directory,
    scripts: {
      [KNOWN_MODEL.split('/')[1] as string]: () => steps.shift()?.() ?? 'Done.',
    },
    overrides: {
      id: 'permission-mode-bureau',
      agentApprovalSecret: 'permission-mode-secret',
      ...(shared === undefined ? {} : { storage: shared.storage }),
      agentSource: agentFileDirectory(directory, { tools: TOOLS }),
    },
  });
  harnesses.push(harness);
  await harness.put(
    'helper.md',
    agentFileText({
      model: KNOWN_MODEL,
      tools: '[read-order, issue-refund]',
      ...(toolApproval === undefined ? {} : { toolApproval }),
    }),
  );
  await harness.bureau.agents.refresh();
  const handler = createBureauHandler(harness.bureau, { authentication });
  return {
    harness,
    bureau: harness.bureau,
    steer: (contextId, commandId, params) =>
      rpc(handler, 'bureau.contexts.steer', { contextId, commandId, ...params }, 'alice-key'),
    settled: async (contextId) => {
      const body = await rpc(handler, 'bureau.contexts.get', { contextId }, 'alice-key');
      return body.result;
    },
  };
}

const pendingOf = (bureau: Bureau, runId: string) =>
  bureau.reviews.list().filter((review) => review.runId === runId);

/** The model asks for `tool` on `orderId` once; a run in the chat `contextId`, or in a new one. */
async function ask(bureau: Bureau, tool: string, orderId: string, contextId?: string) {
  steps.push(() => call(tool, orderId));
  const task = await bureau.tasks.start('helper', 'Go.', {
    principal: OWNER.alice,
    ...(contextId === undefined ? {} : { contextId }),
  });
  await task.result();
  return { id: task.id, contextId: task.contextId };
}

describe('steering a chat’s permission mode over HTTP (COR-1936)', () => {
  it('reads on-changes back for a chat nobody steered, and the settled mode after a steer', async () => {
    const { bureau, steer, settled } = await open();
    const first = await ask(bureau, 'read-order', 'A1');
    expect(await settled(first.contextId)).toMatchObject({
      permissionMode: 'on-changes',
      configVersion: 0,
    });

    const body = await steer(first.contextId, 'to-read-only', { permissionMode: 'read-only' });

    expect(body.result).toMatchObject({
      outcome: 'accepted',
      command: {
        requestedValue: { target: 'permission-mode', override: 'read-only' },
        configVersion: 1,
      },
    });
    expect(await settled(first.contextId)).toMatchObject({
      permissionMode: 'read-only',
      effort: null,
      model: null,
      configVersion: 1,
    });
  });

  it('applies at the next step of a live run: the tool call after the steer is denied', async () => {
    const { bureau, steer } = await open();
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    steps.push(
      () => call('read-order', 'A1'),
      async () => {
        entered.resolve();
        await released.promise;
        return call('issue-refund', 'A1');
      },
    );
    const task = await bureau.tasks.start('helper', 'Go.', { principal: OWNER.alice });
    // Step 0 ran its read-only call; step 1 is generating.
    await entered.promise;

    const body = await steer(task.contextId, 'live-read-only', { permissionMode: 'read-only' });
    released.resolve();
    await task.result();

    expect(body.result).toMatchObject({ outcome: 'accepted' });
    // The refund was neither run nor put to a person: read-only mode denied it.
    expect(executed).toEqual(['read-order:A1']);
    expect(pendingOf(bureau, task.id)).toHaveLength(0);
  });

  it('applies to the next run of an idle chat, which asked before the steer', async () => {
    const { bureau, steer } = await open();
    const before = await ask(bureau, 'issue-refund', 'A1');
    expect(pendingOf(bureau, before.id)).toHaveLength(1);

    await steer(before.contextId, 'idle-read-only', { permissionMode: 'read-only' });
    const after = await ask(bureau, 'issue-refund', 'A2', before.contextId);

    expect(pendingOf(bureau, after.id)).toHaveLength(0);
    expect(executed).toEqual([]);
    // A read-only tool still runs in read-only mode.
    await ask(bureau, 'read-order', 'A3', before.contextId);
    expect(executed).toEqual(['read-order:A3']);
  });

  it('survives a restart: the next run of the chat is held to it', async () => {
    const storage = new MemoryStorage();
    const directory = await mkdtemp(join(tmpdir(), 'bureau-permission-mode-restart-'));
    roots.push(directory);
    const first = await open(undefined, { directory, storage });
    const run = await ask(first.bureau, 'read-order', 'A1');
    await first.steer(run.contextId, 'before-restart', { permissionMode: 'read-only' });
    await first.harness.dispose();
    harnesses.splice(harnesses.indexOf(first.harness), 1);

    const second = await open(undefined, { directory, storage });
    expect(await second.settled(run.contextId)).toMatchObject({
      permissionMode: 'read-only',
      configVersion: 1,
    });
    const again = await ask(second.bureau, 'issue-refund', 'A2', run.contextId);

    expect(pendingOf(second.bureau, again.id)).toHaveLength(0);
    expect(executed).toEqual(['read-order:A1']);
  });

  it('is carried onto a branch of the chat as <commandId>:permission-mode', async () => {
    const { bureau, steer, settled } = await open();
    const run = await ask(bureau, 'read-order', 'A1');
    await steer(run.contextId, 'parent-mode', { permissionMode: 'allow-all' });

    const forked = await bureau.contexts.fork(run.contextId, {
      owner: OWNER.alice,
      commandId: 'fork-mode',
      throughMessageId: null,
    });
    if (!('contextId' in forked)) throw new Error('Expected the fork to be made.');

    expect(forked.carriedPermissionMode).toMatchObject({
      outcome: 'accepted',
      command: { id: 'fork-mode:permission-mode', sessionId: forked.contextId },
    });
    expect(await settled(forked.contextId)).toMatchObject({ permissionMode: 'allow-all' });
    // The parent keeps its own, and a chat that never had one carries none.
    expect(await settled(run.contextId)).toMatchObject({ permissionMode: 'allow-all' });
    const plain = await ask(bureau, 'read-order', 'B1');
    const plainFork = await bureau.contexts.fork(plain.contextId, {
      owner: OWNER.alice,
      commandId: 'fork-plain',
      throughMessageId: null,
    });
    if (!('contextId' in plainFork)) throw new Error('Expected the fork to be made.');
    expect(plainFork.carriedPermissionMode).toBeNull();
    expect(await settled(plainFork.contextId)).toMatchObject({ permissionMode: 'on-changes' });
  });
});

describe('allow-all and always (COR-1936)', () => {
  it('skips the on-changes ask, and never a tool set to always or blocked', async () => {
    const { bureau, steer } = await open('{ issue-refund: always, read-order: blocked }');
    const chat = await ask(bureau, 'read-order', 'A1');
    await steer(chat.contextId, 'allow-all', { permissionMode: 'allow-all' });

    const refund = await ask(bureau, 'issue-refund', 'A2', chat.contextId);
    const read = await ask(bureau, 'read-order', 'A3', chat.contextId);

    // `always` still asks, and `blocked` still denies: nothing ran.
    expect(pendingOf(bureau, refund.id)).toHaveLength(1);
    expect(pendingOf(bureau, read.id)).toHaveLength(0);
    expect(executed).toEqual([]);
  });

  it('lets a mutating tool set to nothing run without asking', async () => {
    const { bureau, steer } = await open();
    const chat = await ask(bureau, 'read-order', 'A1');
    await steer(chat.contextId, 'allow-all', { permissionMode: 'allow-all' });

    const refund = await ask(bureau, 'issue-refund', 'A2', chat.contextId);

    expect(pendingOf(bureau, refund.id)).toHaveLength(0);
    expect(executed).toEqual(['read-order:A1', 'issue-refund:A2']);
  });

  it('asks about a tool a person already allowed for the chat once the chat is set to always', async () => {
    const { bureau, steer } = await open();
    const first = await ask(bureau, 'issue-refund', 'A1');
    const [review] = pendingOf(bureau, first.id);
    if (review?.kind !== 'tool-approval') throw new Error('Expected a tool approval.');
    await bureau.reviews.resolve({
      id: review.id,
      decision: 'approve',
      principal: 'api-key:bob',
      remember: true,
    });
    // Remembered: the next call in the chat runs without asking.
    const lifted = await ask(bureau, 'issue-refund', 'A2', first.contextId);
    expect(pendingOf(bureau, lifted.id)).toHaveLength(0);

    await steer(first.contextId, 'to-always', { permissionMode: 'always' });
    const asked = await ask(bureau, 'issue-refund', 'A3', first.contextId);
    const readOnlyToo = await ask(bureau, 'read-order', 'A4', first.contextId);

    expect(pendingOf(bureau, asked.id)).toHaveLength(1);
    expect(pendingOf(bureau, readOnlyToo.id)).toHaveLength(1);
    expect(executed).toEqual(['issue-refund:A1', 'issue-refund:A2']);
  });

  it('denies a tool that was remembered once the chat is read-only', async () => {
    const { bureau, steer } = await open();
    const first = await ask(bureau, 'issue-refund', 'A1');
    const [review] = pendingOf(bureau, first.id);
    if (review?.kind !== 'tool-approval') throw new Error('Expected a tool approval.');
    await bureau.reviews.resolve({
      id: review.id,
      decision: 'approve',
      principal: 'api-key:bob',
      remember: true,
    });

    await steer(first.contextId, 'to-read-only', { permissionMode: 'read-only' });
    const denied = await ask(bureau, 'issue-refund', 'A2', first.contextId);

    expect(pendingOf(bureau, denied.id)).toHaveLength(0);
    expect(executed).toEqual(['issue-refund:A1']);
  });
});

describe('the steer request (COR-1936)', () => {
  it('refuses a mode that is not one, and a request that also names another setting, changing nothing', async () => {
    const { bureau, steer, settled } = await open();
    const chat = await ask(bureau, 'read-order', 'A1');

    const unknown = await steer(chat.contextId, 'unknown', { permissionMode: 'plan' });
    const both = await steer(chat.contextId, 'both', {
      permissionMode: 'read-only',
      effort: 'low',
    });

    const issuesOf = (body: RpcBody) => body.error?.data?.['issues'];
    expect(unknown.error?.data?.['weftCode']).toBe('InvalidParams');
    expect(issuesOf(unknown)).toEqual([
      expect.objectContaining({ path: ['permissionMode'], code: 'invalid_value' }),
    ]);
    expect(both.error?.data?.['weftCode']).toBe('InvalidParams');
    expect(issuesOf(both)).toEqual([
      expect.objectContaining({
        path: ['permissionMode'],
        message:
          'Exactly one of `override`, `effort` and `permissionMode` is allowed; `effort` and `permissionMode` were sent',
      }),
    ]);
    expect(await settled(chat.contextId)).toMatchObject({
      permissionMode: 'on-changes',
      configVersion: 0,
    });
  });

  it('replays an exact retry, conflicts on a reused commandId, and refuses a stale revision', async () => {
    const { bureau, steer } = await open();
    const chat = await ask(bureau, 'read-order', 'A1');

    const first = await steer(chat.contextId, 'same', { permissionMode: 'always' });
    const retry = await steer(chat.contextId, 'same', { permissionMode: 'always' });
    const reused = await steer(chat.contextId, 'same', { permissionMode: 'read-only' });
    const stale = await steer(chat.contextId, 'stale', {
      permissionMode: 'allow-all',
      expectedRevision: 0,
    });

    expect(first.result).toMatchObject({ outcome: 'accepted' });
    expect(retry.result).toMatchObject({ outcome: 'replayed' });
    expect(reused.result).toMatchObject({ outcome: 'conflict' });
    expect(stale.result).toMatchObject({
      outcome: 'rejected',
      failure: { reason: 'stale-revision' },
    });
  });

  it('refuses a policyRef in process, since no policy profile states a permission mode', async () => {
    const { bureau } = await open();
    const chat = await ask(bureau, 'read-order', 'A1');

    const outcome = await bureau.contexts.steer(chat.contextId, {
      id: 'policy-ref',
      principal: OWNER.alice,
      requestedValue: { target: 'permission-mode', policyRef: 'strict' } as never,
    });

    expect(outcome).toMatchObject({ outcome: 'rejected', failure: { reason: 'policy-denied' } });
  });
});
