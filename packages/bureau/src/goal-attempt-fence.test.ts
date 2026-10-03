/**
 * COR-851 — the self-fence of a goal attempt's run. A start that has claimed its
 * run but not created it can be overtaken by the goal's ending, and the run it
 * then creates must take no step. These tests drive real durable runs under the
 * hook, and the fence over the real goal store.
 */
import { HookRegistry } from '@lostgradient/lifecycle';
import {
  createCheckpointStore,
  createRunEngine,
  createRunWorkflow,
  type DurableActiveRunContext,
  GuardrailTripwireError,
  type OperativeHookMap,
  startDurableRunResult,
  stopWhen,
} from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import {
  createGoalAttemptFence,
  createGoalAttemptFenceHost,
  GOAL_ATTEMPT_FENCE_HOOK_ID,
  GOAL_ATTEMPT_FENCE_READ_TRIES,
  type GoalAttemptFence,
  type GoalAttemptTarget,
  registerGoalAttemptFence,
} from './goal-attempt-fence';
import { createGoalState } from './goal-state';
import { createGoalStore, type GoalStore } from './goal-store';
import type { CatalogRunRecoveryLoad } from './runtime-composition';

const NOW = '2026-10-02T12:00:00.000Z';
const target: GoalAttemptTarget = { goalRunId: 'g1', attemptIndex: 0, runId: 'goal-g1-a0' };

const claimOf = (goalAttempt: {
  goalRunId: string;
  attemptIndex: number;
  tombstonedAt?: string;
}): CatalogRunRecoveryLoad => ({
  status: 'found',
  record: {
    schemaVersion: 1,
    agentName: 'worker',
    definitionRevision: 1,
    input: 'work',
    goalAttempt,
    costEstimation: null,
  },
});

async function liveGoal(): Promise<GoalStore> {
  const store = createGoalStore(textValueStore(new MemoryStorage()));
  await store.create(
    createGoalState({
      goalRunId: 'g1',
      identity: { name: 'goal', version: '1' },
      objective: { agentName: 'worker', prompt: 'work' },
      validator: { name: 'check', version: '1' },
      conversationPolicy: { kind: 'continue' },
      bounds: { maximumAttempts: 2, maximumTotalSteps: 10 },
      now: NOW,
    }),
  );
  return store;
}

describe('createGoalAttemptFence', () => {
  const own = claimOf({ goalRunId: 'g1', attemptIndex: 0 });

  it('lets a live goal’s own, untombstoned attempt run', async () => {
    const fence = createGoalAttemptFence({
      store: await liveGoal(),
      readRunRecord: () => Promise.resolve(own),
    });

    expect(await fence.mayRun(target)).toBe(true);
  });

  it('refuses once the goal’s cancellation is recorded', async () => {
    const store = await liveGoal();
    await store.requestCancellation('g1', { requestedAt: NOW }, NOW);
    const fence = createGoalAttemptFence({ store, readRunRecord: () => Promise.resolve(own) });

    expect(await fence.mayRun(target)).toBe(false);
  });

  it('refuses once the goal is terminal', async () => {
    const store = await liveGoal();
    await store.applyTransition({
      goalRunId: 'g1',
      seq: 1,
      transitionId: 'g1:t1',
      to: 'failed',
      at: NOW,
      cause: 'fail: unsupported-validation',
      terminalReason: 'unsupported-validation',
    });
    const fence = createGoalAttemptFence({ store, readRunRecord: () => Promise.resolve(own) });

    expect(await fence.mayRun(target)).toBe(false);
  });

  it('refuses a goal that cannot be found or read', async () => {
    const fence = createGoalAttemptFence({
      store: { get: () => Promise.resolve(undefined) },
      readRunRecord: () => Promise.resolve(own),
    });

    expect(await fence.mayRun(target)).toBe(false);
  });

  it.each([
    ['a tombstoned claim', claimOf({ goalRunId: 'g1', attemptIndex: 0, tombstonedAt: NOW })],
    ['another attempt’s claim', claimOf({ goalRunId: 'g1', attemptIndex: 1 })],
    ['another goal’s claim', claimOf({ goalRunId: 'g2', attemptIndex: 0 })],
    ['no claim', { status: 'missing' }],
    ['a claim that is not a valid record', { status: 'corrupt' }],
  ] satisfies Array<[string, CatalogRunRecoveryLoad]>)('refuses on %s', async (_label, load) => {
    const fence = createGoalAttemptFence({
      store: await liveGoal(),
      readRunRecord: () => Promise.resolve(load),
    });

    expect(await fence.mayRun(target)).toBe(false);
  });

  it('rejects when the claim cannot be read, which is not a verdict', async () => {
    const fence = createGoalAttemptFence({
      store: await liveGoal(),
      readRunRecord: () =>
        Promise.resolve({ status: 'read-error', error: new Error('storage is down') }),
    });

    let caught: unknown;
    try {
      await fence.mayRun(target);
    } catch (error) {
      caught = error;
    }

    expect((caught as Error | undefined)?.message).toBe('storage is down');
  });
});

describe('the late-bound fence', () => {
  it('refuses until it is bound, so a step that beats the binding fails closed', async () => {
    const host = createGoalAttemptFenceHost();

    let caught: unknown;
    try {
      await host.fence.mayRun(target);
    } catch (error) {
      caught = error;
    }
    expect((caught as Error | undefined)?.name).toBe('GoalAttemptFenceUnboundError');

    host.bind({ mayRun: () => Promise.resolve(true) });
    expect(await host.fence.mayRun(target)).toBe(true);
  });
});

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

async function durableContext(): Promise<DurableActiveRunContext> {
  const storage = new MemoryStorage();
  const checkpointStore = createCheckpointStore(
    textValueStore(storage, { disposeUnderlyingStorage: false }),
  );
  const { engine } = await createRunEngine({
    storage,
    runWorkflow: createRunWorkflow(checkpointStore),
    recover: false,
  });
  disposers.push(() => engine[Symbol.dispose]());
  return { engine, checkpointStore };
}

/** A run of the attempt under the fence, counting the model calls it makes. */
async function fencedRun(fence: GoalAttemptFence) {
  const context = await durableContext();
  const hooks = new HookRegistry<OperativeHookMap>({ source: 'bureau' });
  registerGoalAttemptFence(hooks, fence, target);
  let generates = 0;
  const result = await startDurableRunResult(context, {
    runId: target.runId,
    sessionId: target.runId,
    options: {
      generate: () => {
        generates += 1;
        return Promise.resolve({ content: 'done', toolCalls: [] });
      },
      toolbox: createToolbox([]),
      conversation: createConversationHistory(),
      stopWhen: stopWhen.noToolCalls(),
      hooks,
    },
    prompt: 'go',
  });
  return { result, generates: () => generates, context };
}

describe('registerGoalAttemptFence', () => {
  it('registers a replay-safe prepareStep handler under its own id', () => {
    const hooks = new HookRegistry<OperativeHookMap>({ source: 'bureau' });

    registerGoalAttemptFence(hooks, { mayRun: () => Promise.resolve(true) }, target);

    expect(hooks.getHandlers('prepareStep').map((entry) => entry.id)).toEqual([
      GOAL_ATTEMPT_FENCE_HOOK_ID,
    ]);
  });

  it('lets an allowed run take its step', async () => {
    const { result, generates } = await fencedRun({ mayRun: () => Promise.resolve(true) });

    expect(result.finishReason).toBe('stop-condition');
    expect(generates()).toBe(1);
  });

  it('stops a run the goal no longer allows before its first agent step, ending it cleanly', async () => {
    const { result, generates, context } = await fencedRun({
      mayRun: () => Promise.resolve(false),
    });

    expect(generates()).toBe(0);
    expect(result.steps).toHaveLength(0);
    expect(result.finishReason).toBe('tripwire');
    expect(result.error).toBeInstanceOf(GuardrailTripwireError);
    // The run ended: a workflow in a terminal state, not one left running.
    const state = await context.engine.get(target.runId);
    expect(state?.status).toBe('completed');
  });

  it('retries a read that failed, and lets the run go on once one succeeds', async () => {
    let reads = 0;
    const { result, generates } = await fencedRun({
      mayRun: () => {
        reads += 1;
        return reads < GOAL_ATTEMPT_FENCE_READ_TRIES
          ? Promise.reject(new Error('storage hiccup'))
          : Promise.resolve(true);
      },
    });

    expect(reads).toBe(GOAL_ATTEMPT_FENCE_READ_TRIES);
    expect(result.finishReason).toBe('stop-condition');
    expect(generates()).toBe(1);
  });

  it('fails closed when the goal and claim can never be read: no step is taken on an unknown', async () => {
    let reads = 0;
    const { result, generates } = await fencedRun({
      mayRun: () => {
        reads += 1;
        return Promise.reject(new Error('storage is down'));
      },
    });

    expect(reads).toBe(GOAL_ATTEMPT_FENCE_READ_TRIES);
    expect(generates()).toBe(0);
    expect(result.steps).toHaveLength(0);
    expect(result.finishReason).toBe('tripwire');
    expect(String(result.error)).toContain('storage is down');
  });

  it('is not a handler an onError hook can retry or skip', async () => {
    const context = await durableContext();
    const hooks = new HookRegistry<OperativeHookMap>({ source: 'bureau' });
    registerGoalAttemptFence(hooks, { mayRun: () => Promise.resolve(false) }, target);
    // An agent-tier hook that answers every error with `retry` and then `skip`.
    hooks.on('onError', () => Promise.resolve('skip'));
    let generates = 0;

    const result = await startDurableRunResult(context, {
      runId: target.runId,
      sessionId: target.runId,
      options: {
        generate: () => {
          generates += 1;
          return Promise.resolve({ content: 'done', toolCalls: [] });
        },
        toolbox: createToolbox([]),
        conversation: createConversationHistory(),
        stopWhen: stopWhen.noToolCalls(),
        hooks,
      },
      prompt: 'go',
    });

    expect(generates).toBe(0);
    expect(result.finishReason).toBe('tripwire');
  });
});
