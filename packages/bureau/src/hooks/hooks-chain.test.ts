/**
 * COR-1940 — how a `start-workflow` hook declines the events it cannot place, over a scripted
 * engine: the lookup is asked once per event and only when a workflow would be started, a lookup
 * that fails is treated as a hook's own run, the other actions never ask, and a kind that a run may
 * raise without naming it (`unattributed`) is refused when the hook is written and skipped when a
 * stored record lists it anyway.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';

import type { BureauEventEnvelope } from '../bureau-event-feed.ts';
import type { WebhookDeliveryEngine } from '../webhook-notifier.ts';
import { createHooks } from './create-hooks.ts';
import { HOOK_KEY_PREFIX } from './hook-store.ts';
import { HookError } from './hook-types.ts';

function setup(startedByHook: (runId: string) => Promise<string | undefined>) {
  const tracked: Promise<void>[] = [];
  const engine: WebhookDeliveryEngine = {
    fetch: (() => Promise.resolve(new Response('ok'))) as unknown as typeof fetch,
    now: () => 1_800_000_000_000,
    maxAttempts: 3,
    backoffMilliseconds: () => 0,
    wait: () => Promise.resolve(),
    shuttingDown: () => false,
    signal: new AbortController().signal,
    track: (promise) => {
      tracked.push(promise);
    },
    tracked: (_id, _runId, work) => work(),
  };
  let next = 0;
  const starts: Array<{ tags?: readonly string[] | undefined }> = [];
  const notices: string[] = [];
  const kv = textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false });
  // Whether the workflow files are loaded: a start before then finds no workflow.
  const loaded = { ready: true };
  const created = createHooks({
    kv,
    engine,
    keys: undefined,
    bureauId: 'chain-bureau',
    newId: (kind) => `${kind}-${++next}`,
    audit: () => Promise.resolve(),
    diagnose: () => undefined,
    notice: (message) => {
      notices.push(message);
    },
    startedByHook,
    workflows: () => ({
      assertStartable: () => undefined,
      findStart: () => Promise.resolve(undefined),
      start: (_id, options) => {
        if (!loaded.ready) {
          return Promise.reject(
            Object.assign(new Error('no such workflow'), { code: 'NOT_FOUND' }),
          );
        }
        starts.push({ tags: options.tags });
        return Promise.resolve({ runId: 'run-new', workflow: 'lookup', workflowVersion: 'v1' });
      },
    }),
    notifications: () => ({
      create: () => Promise.resolve({ notification: { id: 'n-1' }, created: true } as never),
    }),
  });
  return {
    hooks: created.hooks,
    created,
    kv,
    loaded,
    starts,
    notices,
    /** Rewrites a stored hook's events, as something that skipped the checks would. */
    async storeEvents(hookId: string, events: readonly string[]): Promise<void> {
      const raw = JSON.parse((await kv.get(`${HOOK_KEY_PREFIX}${hookId}`))!) as {
        revision: number;
      };
      await kv.set(
        `${HOOK_KEY_PREFIX}${hookId}`,
        JSON.stringify({ ...raw, events, revision: raw.revision + 1 }),
      );
    },
    /** Dispatches without opening the hooks first, as an event published during boot is. */
    publishWithoutOpening(kind: string, payload: Record<string, unknown>): void {
      created.dispatch({
        sequence: 0,
        cursor: '0',
        bureauId: 'chain-bureau',
        kind,
        emittedAtMs: 1_800_000_000_000,
        payload,
      } satisfies BureauEventEnvelope);
    },
    async settle(): Promise<void> {
      await Promise.all(tracked.splice(0));
    },
    async fire(kind: string, payload: Record<string, unknown>): Promise<void> {
      await created.resume();
      created.dispatch({
        sequence: 0,
        cursor: '0',
        bureauId: 'chain-bureau',
        kind,
        emittedAtMs: 1_800_000_000_000,
        payload,
      } satisfies BureauEventEnvelope);
      await Promise.all(tracked.splice(0));
    },
  };
}

describe('a start-workflow hook and the origin of an event’s run', () => {
  it('starts the workflow, marked with the hook that started it, for a run no hook started', async () => {
    const asked: string[] = [];
    const run = setup((runId) => {
      asked.push(runId);
      return Promise.resolve(undefined);
    });
    const hook = await run.hooks.create({
      action: { type: 'start-workflow', workflowId: 'lookup' },
      events: ['run.settled'],
    });
    await run.fire('run.settled', { runId: 'r1' });

    expect(asked).toEqual(['r1']);
    expect(run.starts).toEqual([{ tags: [`hook-origin:${hook.id}`] }]);
    expect(run.notices).toEqual([]);
    const [delivery] = await run.hooks.deliveries(hook.id);
    expect(delivery).toMatchObject({ status: 'delivered' });
  });

  it('records a failed delivery with the reason, starts nothing, and reports it, for a run a hook started', async () => {
    const run = setup(() => Promise.resolve('hook-origin-1'));
    const hook = await run.hooks.create({
      action: { type: 'start-workflow', workflowId: 'lookup' },
      events: ['run.settled'],
    });
    await run.fire('run.settled', { runId: 'r1' });

    expect(run.starts).toEqual([]);
    const [delivery] = await run.hooks.deliveries(hook.id);
    expect(delivery).toMatchObject({ status: 'failed' });
    expect(delivery!.attempts).toHaveLength(1);
    expect(delivery!.attempts[0]).toMatchObject({ outcome: 'rejected' });
    expect(delivery!.attempts[0]!.error).toBe((delivery!.work as { skip: string }).skip);
    expect(delivery!.attempts[0]!.error).toContain('hook hook-origin-1 started');
    expect(run.notices).toHaveLength(1);
  });

  it('treats a run it cannot look up as a hook’s own, and says so on the delivery', async () => {
    const run = setup(() => Promise.reject(new Error('storage is closed')));
    const hook = await run.hooks.create({
      action: { type: 'start-workflow', workflowId: 'lookup' },
      events: ['run.settled'],
    });
    await run.fire('run.settled', { runId: 'r1' });

    expect(run.starts).toEqual([]);
    const [delivery] = await run.hooks.deliveries(hook.id);
    expect(delivery).toMatchObject({ status: 'failed' });
    expect(delivery!.attempts[0]!.error).toContain('could not tell');
  });

  it('asks once for an event however many start-workflow hooks list it, and not at all for an event with no run', async () => {
    const asked: string[] = [];
    const run = setup((runId) => {
      asked.push(runId);
      return Promise.resolve(undefined);
    });
    for (const workflowId of ['one', 'two', 'three']) {
      await run.hooks.create({
        action: { type: 'start-workflow', workflowId },
        events: ['run.settled', 'schedule.missed'],
      });
    }
    await run.fire('run.settled', { runId: 'r1' });
    await run.fire('schedule.missed', { scheduleId: 's-1' });

    expect(asked).toEqual(['r1']);
    expect(run.starts).toHaveLength(6);
  });

  it('never asks for a notify hook, which starts nothing', async () => {
    const asked: string[] = [];
    const run = setup((runId) => {
      asked.push(runId);
      return Promise.resolve('hook-origin-1');
    });
    const hook = await run.hooks.create({ action: { type: 'notify' }, events: ['run.settled'] });
    await run.fire('run.settled', { runId: 'r1' });

    expect(asked).toEqual([]);
    const [delivery] = await run.hooks.deliveries(hook.id);
    expect(delivery).toMatchObject({ status: 'delivered' });
  });
});

/** The error a refused `create` or `update` carries, for the field it names. */
async function refusedPath(work: Promise<unknown>): Promise<readonly string[]> {
  const error = await work.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(HookError);
  return (error as HookError).issues[0]!.path;
}

describe('a start-workflow hook and a kind it cannot place', () => {
  const START = { type: 'start-workflow', workflowId: 'lookup' } as const;
  // Kinds a run may raise that name no run: a hook started from one could start itself again.
  const UNPLACED = [
    'notification.created',
    'session.saved',
    'session.created',
    'diagnostic',
    // A run's `bureau:workflows-create` tool writes the files it reports.
    'definitions.changed',
    'schedule.attempted',
    'schedule.skipped',
  ];

  it.each(UNPLACED)(
    'is refused at create and at update for %s, naming the events field',
    async (kind) => {
      const run = setup(() => Promise.resolve(undefined));
      expect(await refusedPath(run.hooks.create({ action: START, events: [kind] }))).toEqual([
        'events',
      ]);
      expect(
        await refusedPath(run.hooks.create({ action: START, events: ['run.settled', kind] })),
      ).toEqual(['events']);
      const hook = await run.hooks.create({ action: START, events: ['run.settled'] });
      expect(await refusedPath(run.hooks.update(hook.id, { events: [kind] }))).toEqual(['events']);
      const unchanged = await run.hooks.get(hook.id);
      expect(unchanged?.events).toEqual(['run.settled']);
    },
  );

  it('may list the kinds that name a run and the kinds no run causes', async () => {
    const run = setup(() => Promise.resolve(undefined));
    const hook = await run.hooks.create({
      action: START,
      events: [
        'run.settled',
        'goal.succeeded',
        'review.requested',
        'bureau.disposed',
        'schedule.missed',
      ],
    });
    expect(hook.events).toHaveLength(5);
  });

  it('leaves a notify hook free to list them (a webhook is covered beside the notification loop)', async () => {
    const run = setup(() => Promise.resolve(undefined));
    await run.hooks.create({ action: { type: 'notify' }, events: ['session.saved', 'diagnostic'] });
  });

  it.each(UNPLACED)(
    'skips %s when a stored record lists it anyway, and says so on the delivery',
    async (kind) => {
      const asked: string[] = [];
      const run = setup((runId) => {
        asked.push(runId);
        return Promise.resolve(undefined);
      });
      const hook = await run.hooks.create({ action: START, events: ['run.settled'] });
      await run.storeEvents(hook.id, [kind]);
      // A payload that names a run does not make the kind placeable: only its classification does.
      await run.fire(kind, { runId: 'r1', sessionId: 's-1' });

      expect(run.starts).toEqual([]);
      expect(asked).toEqual([]);
      const [delivery] = await run.hooks.deliveries(hook.id);
      expect(delivery).toMatchObject({ status: 'failed', kind });
      expect(delivery!.attempts[0]).toMatchObject({ outcome: 'rejected' });
      expect(delivery!.attempts[0]!.error).toContain('Skipped');
      expect(delivery!.attempts[0]!.error).toBe((delivery!.work as { skip: string }).skip);
      expect(run.notices).toHaveLength(1);
    },
  );

  it('skips an event of a run kind that names no run, because it cannot be told from a hook’s own', async () => {
    const run = setup(() => Promise.resolve(undefined));
    const hook = await run.hooks.create({ action: START, events: ['run.settled'] });
    await run.fire('run.settled', {});

    expect(run.starts).toEqual([]);
    const [delivery] = await run.hooks.deliveries(hook.id);
    expect(delivery).toMatchObject({ status: 'failed' });
    expect(delivery!.attempts[0]!.error).toContain('names no run');
  });

  it('starts a workflow for an external kind without asking about any run', async () => {
    const asked: string[] = [];
    const run = setup((runId) => {
      asked.push(runId);
      return Promise.resolve('hook-origin-1');
    });
    await run.hooks.create({ action: START, events: ['schedule.missed', 'bureau.disposed'] });
    await run.fire('schedule.missed', { scheduleId: 's-1', runId: 'r-from-a-hook' });
    await run.fire('bureau.disposed', {});

    expect(asked).toEqual([]);
    expect(run.starts).toHaveLength(2);
  });

  it('holds an event published before the hooks open, and starts the workflow once the files are loaded', async () => {
    const run = setup(() => Promise.resolve(undefined));
    const hook = await run.hooks.create({ action: START, events: ['schedule.missed'] });
    run.loaded.ready = false;

    // Published during boot, before the workflow files are loaded: held, not refused as missing.
    run.publishWithoutOpening('schedule.missed', { scheduleId: 's-1' });
    await run.settle();
    expect(await run.hooks.deliveries(hook.id)).toEqual([]);

    run.loaded.ready = true;
    await run.created.resume();
    await run.settle();
    const [delivery] = await run.hooks.deliveries(hook.id);
    expect(delivery).toMatchObject({ status: 'delivered', kind: 'schedule.missed' });
    expect(delivery!.attempts.map((attempt) => attempt.error)).toEqual([undefined]);
    expect(run.starts).toHaveLength(1);
  });
});
