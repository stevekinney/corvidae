/**
 * COR-1940 — how a `start-workflow` hook declines the events of a run a hook started, over a
 * scripted engine: the lookup is asked once per event and only when a workflow would be started,
 * a lookup that fails is treated as a hook's own run, and the other actions never ask.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';

import type { BureauEventEnvelope } from '../bureau-event-feed.ts';
import type { WebhookDeliveryEngine } from '../webhook-notifier.ts';
import { createHooks } from './create-hooks.ts';

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
  const created = createHooks({
    kv: textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false }),
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
      start: (_id, options) => {
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
    starts,
    notices,
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
        events: ['run.settled', 'definitions.changed'],
      });
    }
    await run.fire('run.settled', { runId: 'r1' });
    await run.fire('definitions.changed', { source: 'workflows', added: [] });

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
