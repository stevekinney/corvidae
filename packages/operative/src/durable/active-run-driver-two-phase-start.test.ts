/**
 * COR-297 — a fresh durable run starts in two phases: `prepare()` commits the run's
 * record and settles `durablyStarted`, the start lifecycle (`run.started`, then
 * `onRunStart`) runs, and only then does `launch()` begin execution. A failing
 * lifecycle abandons the prepared record instead of launching it.
 *
 * Follows `active-run-adapter-abort-manual-clock.test.ts`: a real engine over
 * `MemoryStorage`, a manual runtime, and no real timers or wall-clock waits.
 */
import { createManualRuntimeServices, HookRegistry } from '@lostgradient/lifecycle';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import { stopWhen } from '../conditions/index';
import type { OperativeHookMap } from '../hooks';
import { spyEngine } from '../test/durable-engine';
import { createMockGenerate } from '../test/index';
import type { RunOptions } from '../types';
import type { DurableActiveRunOptions } from './active-run-adapter';
import { isTerminalWorkflowStatus } from './active-run-constants';
import { createDurableActiveRun } from './active-run-create';
import { createCheckpointStore } from './checkpoint-store';
import { createRunEngine, type RegistryAgnosticEngine } from './create-run-engine';
import { createRunWorkflow } from './run-workflow';

async function buildContext() {
  const storage = new MemoryStorage();
  const checkpointStore = createCheckpointStore(
    textValueStore(storage, { disposeUnderlyingStorage: false }),
  );
  const runWorkflow = createRunWorkflow(checkpointStore);
  const { engine } = await createRunEngine({ storage, runWorkflow, recover: false });
  return { engine, checkpointStore, spy: spyEngine(engine) };
}

type Context = Awaited<ReturnType<typeof buildContext>>;

/** An `onRunStart` hook that waits for `release`, then succeeds or throws `failure`. */
function deferredStartHook(failure?: Error): {
  hooks: HookRegistry<OperativeHookMap>;
  reached: Promise<void>;
  release(): void;
  order: string[];
} {
  const hooks = new HookRegistry<OperativeHookMap>();
  const order: string[] = [];
  let resolveReached!: () => void;
  const reached = new Promise<void>((resolve) => {
    resolveReached = resolve;
  });
  let resolveRelease!: () => void;
  const released = new Promise<void>((resolve) => {
    resolveRelease = resolve;
  });
  hooks.on('onRunStart', async () => {
    order.push('onRunStart');
    resolveReached();
    await released;
    if (failure !== undefined) throw failure;
  });
  return { hooks, reached, release: () => resolveRelease(), order };
}

function startRun(
  context: Context,
  runId: string,
  hooks: HookRegistry<OperativeHookMap>,
  extra: Partial<DurableActiveRunOptions> = {},
) {
  const runtime = createManualRuntimeServices();
  const options: RunOptions = {
    generate: createMockGenerate([{ content: 'Done.', toolCalls: [] }]),
    toolbox: createToolbox([]),
    conversation: createConversationHistory(),
    stopWhen: stopWhen.noToolCalls(),
    hooks,
    runtime,
  };
  const activeRun = createDurableActiveRun(
    { engine: context.spy.engine, checkpointStore: context.checkpointStore },
    { runId, sessionId: runId, options, prompt: 'Hello', ...extra },
  );
  const events: string[] = [];
  activeRun.addEventListener('run.completed', () => events.push('run.completed'));
  activeRun.addEventListener('run.aborted', () => events.push('run.aborted'));
  return { activeRun, events };
}

async function statusOf(context: Context, runId: string): Promise<string | undefined> {
  const record = await context.engine.get(runId);
  return record?.status;
}

describe('a fresh durable run started in two phases (COR-297)', () => {
  it('settles durablyStarted while onRunStart is still pending, with the record committed as pending', async () => {
    const context = await buildContext();
    const hook = deferredStartHook();
    const runId = 'two-phase-pending-hook';
    const { activeRun } = startRun(context, runId, hook.hooks);

    await activeRun.durablyStarted;
    await hook.reached;
    expect(await statusOf(context, runId)).toBe('pending');
    expect(context.spy.launches).toEqual([]);

    hook.release();
    const result = await activeRun.result;

    expect(result.finishReason).toBe('stop-condition');
    expect(context.spy.prepares).toEqual([runId]);
    expect(context.spy.launches).toEqual([runId]);
    expect(context.spy.abandons).toEqual([]);
    expect(context.spy.starts).toEqual([]);
    context.engine[Symbol.dispose]();
  });

  it('abandons the prepared record, never launching it, when onRunStart rejects', async () => {
    const context = await buildContext();
    const hook = deferredStartHook(new Error('start hook failed'));
    const runId = 'two-phase-hook-rejects';
    const { activeRun, events } = startRun(context, runId, hook.hooks);

    await activeRun.durablyStarted;
    hook.release();
    const result = await activeRun.result;

    expect(result.finishReason).toBe('error');
    expect((result.error as Error).message).toBe('start hook failed');
    expect(events).toEqual(['run.completed']);
    expect(activeRun.snapshot().result).toEqual({ finishReason: 'error', hasError: true });
    expect(context.spy.abandons).toEqual([runId]);
    expect(context.spy.launches).toEqual([]);
    expect(await statusOf(context, runId)).toBe('cancelled');
    context.engine[Symbol.dispose]();
  });

  it("keeps the hook's error when abandoning the prepared record also fails", async () => {
    const context = await buildContext();
    const realPrepare = context.spy.engine.prepare.bind(context.spy.engine);
    context.spy.engine.prepare = async (...args: Parameters<RegistryAgnosticEngine['prepare']>) => {
      const prepared = await realPrepare(...args);
      return {
        ...prepared,
        id: prepared.id,
        launch: () => prepared.launch(),
        abandon: async () => {
          throw new Error('abandon failed');
        },
      };
    };
    const hook = deferredStartHook(new Error('start hook failed'));
    const { activeRun, events } = startRun(context, 'two-phase-abandon-rejects', hook.hooks);

    hook.release();
    const result = await activeRun.result;

    expect(result.finishReason).toBe('error');
    expect((result.error as Error).message).toBe('start hook failed');
    expect(events).toEqual(['run.completed']);
    context.engine[Symbol.dispose]();
  });

  it('settles as aborted when the run is aborted while onRunStart is pending and the hook then succeeds', async () => {
    const context = await buildContext();
    const hook = deferredStartHook();
    const runId = 'two-phase-abort-hook-succeeds';
    const { activeRun, events } = startRun(context, runId, hook.hooks);

    await hook.reached;
    activeRun.abort('stopped while starting');
    hook.release();
    const result = await activeRun.result;

    expect(result.finishReason).toBe('aborted');
    expect(events).toEqual(['run.aborted']);
    expect(context.spy.launches).toEqual([runId]);
    expect(context.spy.abandons).toEqual([]);
    expect(await statusOf(context, runId)).toBe('cancelled');
    context.engine[Symbol.dispose]();
  });

  it("settles with the hook's error when the run is aborted while onRunStart is pending and the hook then rejects", async () => {
    const context = await buildContext();
    const hook = deferredStartHook(new Error('start hook failed'));
    const runId = 'two-phase-abort-hook-rejects';
    const { activeRun } = startRun(context, runId, hook.hooks);

    await hook.reached;
    activeRun.abort('stopped while starting');
    hook.release();
    const result = await activeRun.result;

    expect(result.finishReason).toBe('error');
    expect((result.error as Error).message).toBe('start hook failed');
    expect(context.spy.abandons).toEqual([runId]);
    expect(await statusOf(context, runId)).toBe('cancelled');
    context.engine[Symbol.dispose]();
  });

  for (const cancelRejects of [false, true]) {
    it(`settles as an error and cancels the record when launch() rejects on its own${cancelRejects ? ', even when that cancel fails' : ''}`, async () => {
      const context = await buildContext();
      const realPrepare = context.spy.engine.prepare.bind(context.spy.engine);
      context.spy.engine.prepare = async (
        ...args: Parameters<RegistryAgnosticEngine['prepare']>
      ) => {
        const prepared = await realPrepare(...args);
        return {
          id: prepared.id,
          launch: async () => {
            throw new Error('launch failed');
          },
          abandon: () => prepared.abandon(),
        };
      };
      if (cancelRejects) {
        const realCancel = context.spy.engine.cancel;
        context.spy.engine.cancel = async (id: string) => {
          await realCancel(id);
          throw new Error('cancel failed');
        };
      }
      const runId = `two-phase-launch-rejects-${String(cancelRejects)}`;
      const { activeRun, events } = startRun(context, runId, new HookRegistry());

      const result = await activeRun.result;

      expect(result.finishReason).toBe('error');
      expect((result.error as Error).message).toBe('launch failed');
      expect(events).toEqual(['run.completed']);
      expect(context.spy.abandons).toEqual([]);
      expect(context.spy.cancels).toEqual([runId]);
      const status = await statusOf(context, runId);
      expect(status !== undefined && isTerminalWorkflowStatus(status)).toBe(true);
      expect(status).toBe('cancelled');
      context.engine[Symbol.dispose]();
    });
  }

  it('never prepares a run aborted before its drive began', async () => {
    const context = await buildContext();
    const { activeRun } = startRun(context, 'two-phase-aborted-before-drive', new HookRegistry());
    activeRun.abort('never mind');

    const result = await activeRun.result;
    await activeRun.durablyStarted;

    expect(result.finishReason).toBe('aborted');
    expect(context.spy.prepares).toEqual([]);
    expect(context.spy.starts).toEqual([]);
    context.engine[Symbol.dispose]();
  });

  it('hands over the services before onRunStart runs, including when the hook then fails', async () => {
    for (const failure of [undefined, new Error('start hook failed')]) {
      const context = await buildContext();
      const hook = deferredStartHook(failure);
      const { activeRun } = startRun(context, `two-phase-services-${String(failure)}`, hook.hooks, {
        onServices: () => hook.order.push('onServices'),
      });

      hook.release();
      await activeRun.result;

      expect(hook.order).toEqual(['onServices', 'onRunStart']);
      context.engine[Symbol.dispose]();
    }
  });

  it('prepares and launches nothing when onServices throws', async () => {
    const context = await buildContext();
    const { activeRun } = startRun(context, 'two-phase-services-throws', new HookRegistry(), {
      onServices: () => {
        throw new Error('onServices exploded');
      },
    });

    const result = await activeRun.result;

    expect(result.finishReason).toBe('error');
    expect(context.spy.prepares).toEqual([]);
    expect(context.spy.launches).toEqual([]);
    context.engine[Symbol.dispose]();
  });
});
