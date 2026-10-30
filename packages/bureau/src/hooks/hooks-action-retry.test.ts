/**
 * COR-1940 — the outcomes of a `start-workflow` delivery that the real Bureau cannot be made to
 * produce on demand: a start that fails in a way a retry may change, and one that fails because the
 * Bureau is shutting down. The hooks are built over a scripted engine, workflows and notifications.
 */
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';

import type { BureauEventEnvelope } from '../bureau-event-feed.ts';
import type { WebhookDeliveryEngine } from '../webhook-notifier.ts';
import { createHooks } from './create-hooks.ts';
import type { HookDelivery } from './hook-types.ts';

type Start = (
  workflowId: string,
  options: { idempotencyKey?: string | undefined },
) => Promise<{
  runId: string;
  workflow: string;
  workflowVersion: string;
}>;

function setup(start: Start) {
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
  let next = 0;
  const diagnostics: string[] = [];
  const created = createHooks({
    kv: textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false }),
    engine,
    keys: undefined,
    bureauId: 'retry-bureau',
    newId: (kind) => `${kind}-${++next}`,
    audit: () => Promise.resolve(),
    diagnose: (message) => {
      diagnostics.push(message);
    },
    workflows: () => ({
      assertStartable: () => undefined,
      start: (workflowId, options) => start(workflowId, options),
    }),
  });
  const envelope = {
    sequence: 0,
    cursor: '0',
    bureauId: 'retry-bureau',
    kind: 'run.settled',
    emittedAtMs: 1_800_000_000_000,
    payload: { runId: 'r1' },
  } satisfies BureauEventEnvelope;
  return {
    hooks: created.hooks,
    state,
    diagnostics,
    async fire(): Promise<void> {
      created.dispatch(envelope);
      await Promise.all(tracked.splice(0));
    },
  };
}

async function onlyDelivery(
  hooks: ReturnType<typeof setup>['hooks'],
  hookId: string,
): Promise<HookDelivery> {
  const delivered = await hooks.deliveries(hookId);
  expect(delivered).toHaveLength(1);
  return delivered[0]!;
}

describe('a start-workflow delivery that fails', () => {
  it('is retried when a retry may change the answer, under one key, until it is exhausted', async () => {
    const keys: Array<string | undefined> = [];
    const run = setup((_id, options) => {
      keys.push(options.idempotencyKey);
      return Promise.reject(new Error('the engine is not ready'));
    });
    const hook = await run.hooks.create({
      action: { type: 'start-workflow', workflowId: 'lookup' },
      events: ['run.settled'],
    });

    await run.fire();
    const delivery = await onlyDelivery(run.hooks, hook.id);

    expect(delivery.status).toBe('exhausted');
    expect(delivery.attempts.map((attempt) => attempt.outcome)).toEqual([
      'error',
      'error',
      'error',
    ]);
    expect(delivery.attempts[0]!.error).toBe('the engine is not ready');
    expect(keys).toEqual([
      `hook:${hook.id}:${delivery.id}`,
      `hook:${hook.id}:${delivery.id}`,
      `hook:${hook.id}:${delivery.id}`,
    ]);
  });

  it('is delivered when a later attempt succeeds, with the run its receipt names', async () => {
    let calls = 0;
    const run = setup(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error('busy'))
        : Promise.resolve({ runId: 'run-9', workflow: 'lookup', workflowVersion: 'v1' });
    });
    const hook = await run.hooks.create({
      action: { type: 'start-workflow', workflowId: 'lookup' },
      events: ['run.settled'],
    });

    await run.fire();
    const delivery = await onlyDelivery(run.hooks, hook.id);

    expect(delivery.status).toBe('delivered');
    expect(delivery.attempts.map((attempt) => attempt.outcome)).toEqual(['error', 'completed']);
    expect(delivery.attempts[1]!.receipt).toEqual({ runId: 'run-9' });
  });

  it('is released, not failed, when the Bureau shuts down under it, so a restart resumes it', async () => {
    const run = setup(() => {
      run.state.shuttingDown = true;
      return Promise.reject(new Error('the engine is closing'));
    });
    const hook = await run.hooks.create({
      action: { type: 'start-workflow', workflowId: 'lookup' },
      events: ['run.settled'],
    });

    await run.fire();
    const delivery = await onlyDelivery(run.hooks, hook.id);

    expect(delivery.status).toBe('pending');
    expect(delivery.attempts.map((attempt) => attempt.outcome)).toEqual(['interrupted']);
  });

  it('records a refusal the engine marks permanent as one attempt and a failed delivery', async () => {
    let calls = 0;
    const run = setup(() => {
      calls += 1;
      return Promise.reject(
        Object.assign(new Error('Workflow "lookup" does not exist'), { code: 'NOT_FOUND' }),
      );
    });
    const hook = await run.hooks.create({
      action: { type: 'start-workflow', workflowId: 'lookup' },
      events: ['run.settled'],
    });

    await run.fire();
    const delivery = await onlyDelivery(run.hooks, hook.id);

    expect(calls).toBe(1);
    expect(delivery.status).toBe('failed');
    expect(delivery.attempts.map((attempt) => attempt.outcome)).toEqual(['rejected']);
  });
});
