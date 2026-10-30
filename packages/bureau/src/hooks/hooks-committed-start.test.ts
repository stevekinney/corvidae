/**
 * COR-1951 — a `start-workflow` delivery whose start had already committed when the process
 * stopped is delivered with that run after the restart, whatever has since happened to the workflow
 * file. Without the lookup the resumed delivery validated against the current file first, so an
 * edited, paused, or deleted workflow ended it `failed` for a run that did start.
 *
 * The workflows are scripted in the order the real Bureau checks them: the file's state first
 * (a missing or paused workflow, then an input its edited schema refuses), then Weft's
 * idempotency dedup, which is the only place a committed key answers.
 */
import {
  type ConditionalTextValueStore,
  MemoryStorage,
  textValueStore,
} from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';

import type { BureauEventEnvelope } from '../bureau-event-feed.ts';
import type { WebhookDeliveryEngine } from '../webhook-notifier.ts';
import { createHooks } from './create-hooks.ts';
import type { HookDelivery } from './hook-types.ts';

type FileState = 'unchanged' | 'edited' | 'paused' | 'deleted';

interface World {
  /** What the file is now. */
  file: FileState;
  /** The keys whose start committed, and the run each created. */
  readonly committed: Map<string, string>;
  /** How the lookup answers; a failure says nothing about whether a run exists. */
  lookup: 'answers' | 'fails' | 'purged' | 'fails-once';
  /**
   * Set while the first process runs: a start then stops the process under the delivery, after
   * committing when `commits` is true, before the delivery can write its receipt.
   */
  crash: { readonly commits: boolean; readonly stop: () => void } | undefined;
  startCalls: number;
  lookupCalls: number;
}

const result = (runId: string) => ({ runId, workflow: 'lookup', workflowVersion: 'v1' });

function workflowsOf(world: World) {
  return () => ({
    assertStartable: () => undefined,
    findStart: (key: string) => {
      world.lookupCalls += 1;
      if (world.lookup === 'fails' || (world.lookup === 'fails-once' && world.lookupCalls === 1)) {
        return Promise.reject(new Error('storage unavailable'));
      }
      if (world.lookup === 'purged') {
        return Promise.reject(
          Object.assign(new Error('The key maps to a run that no longer exists'), {
            code: 'IdempotencyKeyPurgedError',
          }),
        );
      }
      const runId = world.committed.get(key);
      return Promise.resolve(runId === undefined ? undefined : result(runId));
    },
    start: (_id: string, options: { idempotencyKey?: string | undefined }) => {
      world.startCalls += 1;
      const key = options.idempotencyKey!;
      // The order the real Bureau checks in: the file first, Weft's dedup after it.
      if (world.crash === undefined) {
        if (world.file === 'paused' || world.file === 'deleted') {
          return Promise.reject(
            Object.assign(new Error('Workflow "lookup" does not exist'), { code: 'NOT_FOUND' }),
          );
        }
        if (world.file === 'edited') {
          return Promise.reject(
            Object.assign(new Error('The input no longer matches the schema'), {
              code: 'input-invalid',
            }),
          );
        }
      }
      if (world.crash === undefined || world.crash.commits) {
        world.committed.set(key, world.committed.get(key) ?? `run-for-${key}`);
      }
      if (world.crash !== undefined) {
        world.crash.stop();
        return Promise.reject(new Error('the process is stopping'));
      }
      return Promise.resolve(result(world.committed.get(key)!));
    },
  });
}

const envelope = {
  sequence: 0,
  cursor: '0',
  bureauId: 'committed-bureau',
  kind: 'run.settled',
  emittedAtMs: 1_800_000_000_000,
  payload: { runId: 'r1' },
} satisfies BureauEventEnvelope;

/** One process over the shared store; `state.shuttingDown` is what stops it mid-delivery. */
function openProcess(kv: ConditionalTextValueStore, world: World, ids: { next: number }) {
  const tracked: Promise<void>[] = [];
  const state = { shuttingDown: false };
  const engine: WebhookDeliveryEngine = {
    fetch: (() => Promise.reject(new Error('no request is made'))) as unknown as typeof fetch,
    now: () => 1_800_000_000_000,
    maxAttempts: 3,
    backoffMilliseconds: () => 0,
    wait: () => Promise.resolve(),
    shuttingDown: () => state.shuttingDown,
    signal: new AbortController().signal,
    track: (promise) => {
      tracked.push(promise);
    },
    tracked: (_id, _runId, work) => work(),
  };
  const created = createHooks({
    kv,
    engine,
    keys: undefined,
    bureauId: 'committed-bureau',
    newId: (kind) => `${kind}-${++ids.next}`,
    audit: () => Promise.resolve(),
    diagnose: () => undefined,
    workflows: workflowsOf(world),
  });
  return {
    hooks: created.hooks,
    state,
    async resume(): Promise<void> {
      await created.resume();
      await Promise.all(tracked.splice(0));
    },
    async fire(): Promise<void> {
      await created.resume();
      created.dispatch(envelope);
      await Promise.all(tracked.splice(0));
    },
  };
}

/**
 * The first process starts the workflow (committing the key or not) and stops under the delivery,
 * which is released pending. Then the file changes and a second process resumes it.
 */
async function resumedAfter(options: {
  readonly startCommitted: boolean;
  readonly file: FileState;
  readonly lookup?: World['lookup'];
}): Promise<{ delivery: HookDelivery; world: World; key: string }> {
  const kv = textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false });
  const ids = { next: 0 };
  const world: World = {
    file: 'unchanged',
    committed: new Map(),
    lookup: 'answers',
    crash: undefined,
    startCalls: 0,
    lookupCalls: 0,
  };

  const first = openProcess(kv, world, ids);
  world.crash = {
    commits: options.startCommitted,
    stop: () => {
      first.state.shuttingDown = true;
    },
  };
  const hook = await first.hooks.create({
    action: { type: 'start-workflow', workflowId: 'lookup' },
    events: ['run.settled'],
  });
  await first.fire();
  const [stopped] = await first.hooks.deliveries(hook.id);
  expect(stopped!.status).toBe('pending');
  expect(world.committed.size).toBe(options.startCommitted ? 1 : 0);

  world.crash = undefined;
  world.file = options.file;
  world.lookup = options.lookup ?? 'answers';
  world.startCalls = 0;
  world.lookupCalls = 0;
  const second = openProcess(kv, world, ids);
  await second.resume();

  const [delivery] = await second.hooks.deliveries(hook.id);
  return { delivery: delivery!, world, key: `hook:${hook.id}:${delivery!.id}` };
}

const FILES: readonly FileState[] = ['unchanged', 'edited', 'paused', 'deleted'];

describe('a start-workflow delivery resumed after its start committed', () => {
  it.each(FILES)(
    'is delivered with the committed run when the workflow is %s, without a second start',
    async (file) => {
      const { delivery, world, key } = await resumedAfter({ startCommitted: true, file });

      expect(delivery.status).toBe('delivered');
      expect(delivery.attempts.map((attempt) => attempt.outcome)).toEqual([
        'interrupted',
        'completed',
      ]);
      expect(delivery.attempts[1]!.receipt).toEqual({ runId: `run-for-${key}` });
      expect(world.startCalls).toBe(0);
      expect(world.committed.size).toBe(1);
    },
  );
});

describe('a start-workflow delivery resumed when its start had not committed', () => {
  it('starts the run under the same key when the workflow is unchanged', async () => {
    const { delivery, world, key } = await resumedAfter({
      startCommitted: false,
      file: 'unchanged',
    });

    expect(delivery.status).toBe('delivered');
    expect(delivery.attempts[1]!.receipt).toEqual({ runId: `run-for-${key}` });
    expect(world.startCalls).toBe(1);
    expect(world.committed.size).toBe(1);
  });

  it.each(['edited', 'paused', 'deleted'] as const)(
    'still ends failed on its one rejected attempt when the workflow is %s',
    async (file) => {
      const { delivery, world } = await resumedAfter({ startCommitted: false, file });

      expect(delivery.status).toBe('failed');
      expect(delivery.attempts.map((attempt) => attempt.outcome)).toEqual([
        'interrupted',
        'rejected',
      ]);
      expect(world.startCalls).toBe(1);
      expect(world.committed.size).toBe(0);
    },
  );
});

describe('a start-workflow delivery whose lookup does not answer', () => {
  it.each(FILES)(
    'is neither delivered nor failed, and starts nothing, when the workflow is %s',
    async (file) => {
      const { delivery, world } = await resumedAfter({
        startCommitted: true,
        file,
        lookup: 'fails',
      });

      expect(delivery.status).toBe('exhausted');
      expect(delivery.attempts.slice(1).map((attempt) => attempt.outcome)).toEqual([
        'error',
        'error',
      ]);
      expect(world.startCalls).toBe(0);
    },
  );

  it('is delivered once a later lookup answers', async () => {
    const { delivery, world, key } = await resumedAfter({
      startCommitted: true,
      file: 'paused',
      lookup: 'fails-once',
    });

    expect(delivery.status).toBe('delivered');
    expect(delivery.attempts.map((attempt) => attempt.outcome)).toEqual([
      'interrupted',
      'error',
      'completed',
    ]);
    expect(delivery.attempts[2]!.receipt).toEqual({ runId: `run-for-${key}` });
    expect(world.startCalls).toBe(0);
  });

  it('fails once when the key was used but its run has been purged', async () => {
    const { delivery, world } = await resumedAfter({
      startCommitted: true,
      file: 'unchanged',
      lookup: 'purged',
    });

    expect(delivery.status).toBe('failed');
    expect(delivery.attempts.map((attempt) => attempt.outcome)).toEqual([
      'interrupted',
      'rejected',
    ]);
    expect(world.startCalls).toBe(0);
  });
});
