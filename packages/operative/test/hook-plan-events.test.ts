import { createTestToolbox } from 'armorer';
import { Conversation } from 'conversationalist';
import { HookRegistry } from '@lostgradient/lifecycle';
import { describe, expect, it } from 'bun:test';

import { noToolCalls } from '../src/conditions/predicates';
import { createActiveRun } from '../src/create-run';
import {
  HookPlanFailedEvent,
  HookPlanInvokedEvent,
  HookPlanRegisteredEvent,
  HookPlanRemovedEvent,
  OPERATIVE_EVENT_TYPES,
} from '../src/events';
import type { OperativeHookMap } from '../src/hooks';

type PlanRecord = {
  kind: string;
  hookName: string;
  hookId: string;
  runId: string | undefined;
};

async function runWithPlan(
  hooks: HookRegistry<OperativeHookMap>,
  options: { runId?: string; onRun?: (run: ReturnType<typeof createActiveRun>) => void } = {},
): Promise<PlanRecord[]> {
  const observed: PlanRecord[] = [];
  const activeRun = createActiveRun({
    generate: async () => ({ content: 'done', toolCalls: [] }),
    toolbox: createTestToolbox([]),
    conversation: new Conversation(),
    stopWhen: noToolCalls(),
    hooks,
    ...(options.runId === undefined ? {} : { runId: options.runId }),
  });

  for (const [kind, type] of [
    ['registered', HookPlanRegisteredEvent.type],
    ['invoked', HookPlanInvokedEvent.type],
    ['failed', HookPlanFailedEvent.type],
    ['removed', HookPlanRemovedEvent.type],
  ] as const) {
    activeRun.addEventListener(type, (event) => {
      observed.push({
        kind,
        hookName: event.hookName,
        hookId: event.hookId,
        runId: event.runId,
      });
    });
  }

  options.onRun?.(activeRun);
  await activeRun.result;
  return observed;
}

describe('COR-766: hook-plan events', () => {
  it('announces every entry of the plan the run was dispatched with', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('prepareStep', async () => undefined, { id: 'identity' });
    hooks.on('onStep', async () => {}, { id: 'persist' });

    const observed = await runWithPlan(hooks, { runId: 'run-census' });
    const registered = observed.filter((entry) => entry.kind === 'registered');

    // The plan was fully composed before the run saw it, which is the bureau
    // case: a live subscription alone would announce nothing at all.
    expect(registered.map((entry) => entry.hookId)).toEqual(['identity', 'persist']);
    expect(registered.every((entry) => entry.runId === 'run-census')).toBe(true);
  });

  it('carries the registered priority and replay classification', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('onStep', async () => {}, { id: 'write-back', priority: -1000, replay: 'effectful' });
    hooks.on('prepareStep', async () => undefined, { id: 'recall', replay: 'safe' });

    const events: HookPlanRegisteredEvent[] = [];
    const activeRun = createActiveRun({
      generate: async () => ({ content: 'done', toolCalls: [] }),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });
    activeRun.addEventListener(HookPlanRegisteredEvent.type, (event) => events.push(event));
    await activeRun.result;

    const writeBack = events.find((event) => event.hookId === 'write-back');
    expect(writeBack?.priority).toBe(-1000);
    expect(writeBack?.replay).toBe('effectful');
    expect(events.find((event) => event.hookId === 'recall')?.replay).toBe('safe');
  });

  it('reports an entry with no declared replay policy as the conservative effectful', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('onStep', async () => {}, { id: 'unclassified' });

    const events: HookPlanRegisteredEvent[] = [];
    const activeRun = createActiveRun({
      generate: async () => ({ content: 'done', toolCalls: [] }),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });
    activeRun.addEventListener(HookPlanRegisteredEvent.type, (event) => events.push(event));
    await activeRun.result;

    expect(events.find((event) => event.hookId === 'unclassified')?.replay).toBe('effectful');
  });

  it('fires invoked once per invocation, correlated to the owning run', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('prepareStep', async () => undefined, { id: 'identity' });

    const observed = await runWithPlan(hooks, { runId: 'run-invoked' });
    const invoked = observed.filter(
      (entry) => entry.hookId === 'identity' && entry.kind === 'invoked',
    );

    expect(invoked).toHaveLength(1);
    expect(invoked[0]?.hookName).toBe('prepareStep');
    expect(invoked[0]?.runId).toBe('run-invoked');
  });

  it('announces an entry before reporting any invocation of it', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('prepareStep', async () => undefined, { id: 'identity' });

    const observed = await runWithPlan(hooks);
    const firstRegistered = observed.findIndex(
      (entry) => entry.kind === 'registered' && entry.hookId === 'identity',
    );
    const firstInvoked = observed.findIndex(
      (entry) => entry.kind === 'invoked' && entry.hookId === 'identity',
    );

    expect(firstRegistered).toBeGreaterThanOrEqual(0);
    expect(firstInvoked).toBeGreaterThan(firstRegistered);
  });

  it('observes onRunStart, which runs before the loop does', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('onRunStart', async () => {}, { id: 'run-start' });

    const observed = await runWithPlan(hooks, { runId: 'run-start-observed' });

    expect(observed).toContainEqual({
      kind: 'invoked',
      hookName: 'onRunStart',
      hookId: 'run-start',
      runId: 'run-start-observed',
    });
  });

  it('reports a throwing handler as failed and never also as invoked', async () => {
    const hooks = new HookRegistry<OperativeHookMap>({ onError: () => 'continue' });
    hooks.on(
      'onStep',
      async () => {
        throw new Error('hook exploded');
      },
      { id: 'thrower' },
    );

    const observed = await runWithPlan(hooks, { runId: 'run-failed' });
    const outcomes = observed.filter(
      (entry) => entry.hookId === 'thrower' && entry.kind !== 'registered',
    );

    expect(outcomes.map((entry) => entry.kind)).toEqual(['failed']);
  });

  it('carries the error and duration on a failure', async () => {
    const failure = new Error('hook exploded');
    const hooks = new HookRegistry<OperativeHookMap>({ onError: () => 'continue' });
    hooks.on(
      'onStep',
      async () => {
        throw failure;
      },
      { id: 'thrower' },
    );

    const events: HookPlanFailedEvent[] = [];
    const activeRun = createActiveRun({
      generate: async () => ({ content: 'done', toolCalls: [] }),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
    });
    activeRun.addEventListener(HookPlanFailedEvent.type, (event) => events.push(event));
    await activeRun.result;

    expect(events).toHaveLength(1);
    expect(events[0]?.error).toBe(failure);
    expect(typeof events[0]?.durationMilliseconds).toBe('number');
  });

  it('reports an entry unregistered while the run holds the plan', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();
    const dispose = hooks.on('onStep', async () => {}, { id: 'transient' });

    const observed: PlanRecord[] = [];
    const activeRun = createActiveRun({
      // Unregistering from inside the generate call puts the removal squarely
      // inside the run's lifetime. Doing it before `await result` would land
      // before the plan is even censused, which proves nothing.
      generate: async () => {
        dispose();
        return { content: 'done', toolCalls: [] };
      },
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
      runId: 'run-removed',
    });
    activeRun.addEventListener(HookPlanRemovedEvent.type, (event) => {
      observed.push({
        kind: 'removed',
        hookName: event.hookName,
        hookId: event.hookId,
        runId: event.runId,
      });
    });
    await activeRun.result;

    expect(observed).toEqual([
      {
        kind: 'removed',
        hookName: 'onStep',
        hookId: 'transient',
        runId: 'run-removed',
      },
    ]);
  });

  it('reports an entry registered while the run is live', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();

    const observed = await runWithPlan(hooks, {
      runId: 'run-late',
      onRun: () => hooks.on('onStep', async () => {}, { id: 'late' }),
    });

    expect(observed).toContainEqual({
      kind: 'registered',
      hookName: 'onStep',
      hookId: 'late',
      runId: 'run-late',
    });
  });

  it('stops observing a registry that outlives the run', async () => {
    const hooks = new HookRegistry<OperativeHookMap>();
    hooks.on('onStep', async () => {}, { id: 'persistent' });

    const firstRunEvents: string[] = [];
    const firstRun = createActiveRun({
      generate: async () => ({ content: 'done', toolCalls: [] }),
      toolbox: createTestToolbox([]),
      conversation: new Conversation(),
      stopWhen: noToolCalls(),
      hooks,
      runId: 'run-one',
    });
    firstRun.addEventListener(HookPlanRegisteredEvent.type, (event) =>
      firstRunEvents.push(event.hookId),
    );
    await firstRun.result;

    const countDuringFirstRun = firstRunEvents.length;
    expect(countDuringFirstRun).toBe(1);

    // The registry outlives the run — a direct caller may reuse one across
    // runs. Without teardown each completed run leaves an observer behind,
    // dispatching into an emitter whose run has already settled.
    hooks.on('onStep', async () => {}, { id: 'after-first-run' });

    expect(firstRunEvents).toHaveLength(countDuringFirstRun);
  });

  it('declares no hook-plan.replayed event type', () => {
    // The criterion asked for one; it cannot be met without durable per-entry
    // invocation history, which `HookReplayPolicy`'s idempotency contract
    // rejects. Pinned so a later addition is a deliberate decision rather than
    // an oversight.
    expect(OPERATIVE_EVENT_TYPES).toContain('hook-plan.invoked');
    expect(OPERATIVE_EVENT_TYPES.filter((type) => type.startsWith('hook-plan.'))).toEqual([
      'hook-plan.registered',
      'hook-plan.invoked',
      'hook-plan.failed',
      'hook-plan.removed',
    ]);
  });
});
