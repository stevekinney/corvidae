import { CompletableEventTarget } from '@lostgradient/lifecycle';
import {
  MemoryStorage,
  textValueStore,
  workflow,
  WorkflowCheckpointConflictError,
  yieldToPortableEventLoop,
} from '@lostgradient/weft';
import { createToolbox } from 'armorer';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createConversationHistory } from 'conversationalist';

import { stopWhen } from '../conditions/index';
import { AgentRunError } from '../errors';
import {
  RunAbortedEvent,
  RunCompletedEvent,
  RunErrorEvent,
  type CombinedOperativeEventMap,
} from '../events';
import type { RunOptions, RunResult } from '../types';
import { createDurableActiveRun } from './active-run-create';
import { reattachDurableActiveRun } from './active-run-reattach';
import { createCheckpointStore } from './checkpoint-store';
import { createRunEngine, type RegistryAgnosticEngine } from './create-run-engine';
import { AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION } from './run-workflow-result';

/**
 * COR-1587: a durable run whose `handle.result()` rejects with anything the drivers do not already
 * classify settles as `error`. The fresh-run driver and the reattach driver both fire one
 * `run.completed` with `finishReason: 'error'` and the rejection's message, so the session, the
 * run record, and attached streams all end. The cases the drivers deliberately leave write-free
 * (a disposed engine, a lost checkpoint compare-and-swap, a run another engine owns, a run the
 * recovery resolver failed before replay) fire nothing.
 */

function runOptions(): RunOptions {
  return {
    generate: async () => ({ content: 'unused', toolCalls: [] }),
    toolbox: createToolbox([]),
    conversation: createConversationHistory(),
    stopWhen: stopWhen.noToolCalls(),
  };
}

type TerminalRecord = {
  readonly type: string;
  readonly finishReason?: string | undefined;
  readonly error?: string | undefined;
};

function observeTerminalLifecycle(emitter: CompletableEventTarget<CombinedOperativeEventMap>) {
  const terminalEvents: TerminalRecord[] = [];
  emitter.addEventListener(RunCompletedEvent.type, (event) => {
    terminalEvents.push({
      type: RunCompletedEvent.type,
      finishReason: event.finishReason,
      error: messageOf(event.error),
    });
  });
  emitter.addEventListener(RunErrorEvent.type, (event) => {
    terminalEvents.push({ type: RunErrorEvent.type, error: event.error.message });
  });
  emitter.addEventListener(RunAbortedEvent.type, () => {
    terminalEvents.push({ type: RunAbortedEvent.type });
  });
  return terminalEvents;
}

/** The message of a reported error, whatever type the event declares it as. */
const messageOf = (error: unknown): string | undefined =>
  error instanceof Error ? error.message : undefined;

/** A checkpoint store with nothing in it: the run failed before it committed a step. */
const emptyCheckpointStore = createCheckpointStore(
  textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false }),
);

/** Resolves after one macrotask, so a rejection nobody handled has been reported by then. */
const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

let unhandledRejections: unknown[] = [];
const recordUnhandledRejection = (reason: unknown) => {
  unhandledRejections.push(reason);
};

beforeEach(() => {
  unhandledRejections = [];
  process.on('unhandledRejection', recordUnhandledRejection);
});

afterEach(() => {
  process.off('unhandledRejection', recordUnhandledRejection);
});

type Driver = {
  readonly name: string;
  /** Settle a run whose `handle.result()` rejects with `rejection`. */
  readonly settle: (
    rejection: unknown,
    emitter: CompletableEventTarget<CombinedOperativeEventMap>,
    engineOverrides?: Record<string, unknown>,
  ) => Promise<RunResult>;
};

const drivers: readonly Driver[] = [
  {
    name: 'fresh-run driver',
    settle: async (rejection, emitter, engineOverrides = {}) => {
      const engine = {
        start: async () => ({ result: () => Promise.reject(rejection) }),
        ...engineOverrides,
      } as unknown as RegistryAgnosticEngine;
      const activeRun = createDurableActiveRun(
        { engine, checkpointStore: emptyCheckpointStore },
        { runId: 'fresh-run', sessionId: 'fresh-run', options: runOptions(), emitter },
      );
      return activeRun.result;
    },
  },
  {
    name: 'reattach driver',
    settle: async (rejection, emitter, engineOverrides = {}) => {
      const engine = {
        cancel: async () => {},
        ...engineOverrides,
      } as unknown as RegistryAgnosticEngine;
      const recoveredRun = reattachDurableActiveRun(
        { engine, checkpointStore: emptyCheckpointStore },
        {
          runId: 'reattached-run',
          handle: { id: 'reattached-run', result: () => Promise.reject(rejection) },
          emitter,
        },
      );
      return recoveredRun.result;
    },
  },
];

/** What a replayed run's engine reads back: the failure is recent, so the state is not terminal. */
const stateAfterReplay = { get: async () => ({ status: 'running' }) };

describe('a durable run whose result rejects with an unclassified error', () => {
  for (const driver of drivers) {
    it(`settles as error with the rejection's message (${driver.name}, plain Error)`, async () => {
      const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
      const terminalEvents = observeTerminalLifecycle(emitter);

      const result = await driver.settle(
        new Error('x marks the failure'),
        emitter,
        stateAfterReplay,
      );
      await macrotask();

      expect(result.finishReason).toBe('error');
      expect(messageOf(result.error)).toContain('x marks the failure');
      // `run.error`, then one `run.completed`: the pair a failed run fires, which is what tells a
      // listener the run failed rather than finished.
      expect(terminalEvents).toEqual([
        { type: RunErrorEvent.type, error: messageOf(result.error) },
        { type: RunCompletedEvent.type, finishReason: 'error', error: messageOf(result.error) },
      ]);
      expect(unhandledRejections).toEqual([]);
    });

    it(`settles as error when the rejection carries a code the driver does not recognise (${driver.name})`, async () => {
      const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
      const terminalEvents = observeTerminalLifecycle(emitter);
      const rejection = Object.assign(new Error('x refused by the store'), {
        code: 'SomeUnrelatedWeftError',
      });

      const result = await driver.settle(rejection, emitter, stateAfterReplay);
      await macrotask();

      expect(result.finishReason).toBe('error');
      expect(messageOf(result.error)).toContain('x refused by the store');
      expect(terminalEvents.map(({ type, finishReason }) => ({ type, finishReason }))).toEqual([
        { type: RunErrorEvent.type, finishReason: undefined },
        { type: RunCompletedEvent.type, finishReason: 'error' },
      ]);
      expect(unhandledRejections).toEqual([]);
    });
  }

  it('marks the run.error settleRejectedRun announces as reconstructed', async () => {
    const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
    const announced: RunErrorEvent[] = [];
    emitter.addEventListener(RunErrorEvent.type, (event) => announced.push(event));

    const result = await drivers[0]!.settle(new Error('x refused by the store'), emitter);

    expect(result.finishReason).toBe('error');
    // The step count it passes is what the run recorded, not the step that failed.
    expect(announced).toHaveLength(1);
    expect(announced[0]!.reconstructed).toBe(true);
  });

  it('keeps the error a step already reported, and does not repeat run.error', async () => {
    const stepError = new AgentRunError('the model refused', { kind: 'generate', code: 'UNKNOWN' });
    const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
    const terminalEvents = observeTerminalLifecycle(emitter);
    const engine = {
      start: async () => ({
        result: () => {
          emitter.dispatch(new RunErrorEvent(0, stepError, 'generate'));
          return Promise.reject(new Error('the activity failed afterwards'));
        },
      }),
    } as unknown as RegistryAgnosticEngine;

    const activeRun = createDurableActiveRun(
      { engine, checkpointStore: emptyCheckpointStore },
      { runId: 'step-error', sessionId: 'step-error', options: runOptions(), emitter },
    );
    const result = await activeRun.result;

    expect(result.finishReason).toBe('error');
    expect(result.error).toBe(stepError);
    expect(terminalEvents).toEqual([
      { type: RunErrorEvent.type, error: 'the model refused' },
      { type: RunCompletedEvent.type, finishReason: 'error', error: 'the model refused' },
    ]);
  });

  it('settles a reattached run when the engine cannot report its state', async () => {
    const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
    const terminalEvents = observeTerminalLifecycle(emitter);

    const result = await drivers[1]!.settle(new Error('x after a state read failure'), emitter, {
      get: async () => {
        throw new Error('state unavailable');
      },
    });

    expect(result.finishReason).toBe('error');
    expect(terminalEvents.map(({ type }) => type)).toEqual([
      RunErrorEvent.type,
      RunCompletedEvent.type,
    ]);
  });
});

describe('a durable run whose result rejects with a CheckpointCommitFailedError (COR-1626)', () => {
  // The engine gave up on a refused checkpoint or workflow-state write: it failed the run as a
  // `system` failure, or, when even the failure write was refused, abandoned the run locally and
  // rejected `result()`, including a `result()` requested afterwards. The error is not exported
  // from the Weft root, so the driver sees only its code, as it does for any other Weft error it
  // has no case for. Neither driver treats it like a disposed engine or a lost checkpoint race,
  // which stay write-free: this run is over for this process, so its session must end too.
  const refused = () =>
    Object.assign(
      new Error('Workflow "run" failure write was refused by storage on all 5 attempts: refused'),
      { code: 'CheckpointCommitFailedError', write: 'failure', attempts: 5 },
    );

  for (const driver of drivers) {
    it(`settles the session as error: run.error, then one run.completed (${driver.name})`, async () => {
      const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
      const terminalEvents = observeTerminalLifecycle(emitter);

      const result = await driver.settle(refused(), emitter, stateAfterReplay);
      await macrotask();

      expect(result.finishReason).toBe('error');
      expect(messageOf(result.error)).toContain('refused by storage on all 5 attempts');
      expect(terminalEvents).toEqual([
        { type: RunErrorEvent.type, error: messageOf(result.error) },
        { type: RunCompletedEvent.type, finishReason: 'error', error: messageOf(result.error) },
      ]);
      expect(unhandledRejections).toEqual([]);
    });
  }
});

describe('a durable run whose result rejects with a WorkflowTimeoutError', () => {
  const timeout = () =>
    Object.assign(new Error('workflow timed out'), { code: 'WorkflowTimeoutError' });

  for (const [driver, expected] of [
    [drivers[0]!, 'execution deadline'],
    [drivers[1]!, 'history circuit breaker'],
  ] as const) {
    it(`settles as error and fires run.error then one run.completed (${driver.name})`, async () => {
      const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
      const terminalEvents = observeTerminalLifecycle(emitter);

      const result = await driver.settle(timeout(), emitter, {
        get: async () =>
          expected === 'history circuit breaker'
            ? { status: 'timed-out', terminationReason: 'history-circuit-breaker' }
            : { status: 'timed-out' },
      });
      await macrotask();

      // `run.error` is what turns the run record to `error` and ends an AG-UI stream with
      // `RUN_ERROR`; `run.completed` alone reads as a run that finished.
      expect(result.finishReason).toBe('error');
      expect(messageOf(result.error)).toContain(expected);
      expect(terminalEvents).toEqual([
        { type: RunErrorEvent.type, error: messageOf(result.error) },
        { type: RunCompletedEvent.type, finishReason: 'error', error: messageOf(result.error) },
      ]);
      expect(unhandledRejections).toEqual([]);
    });
  }
});

describe('a durable run whose resolved summary is malformed', () => {
  // A current-version summary that breaks its own shape (`InvalidRunResultError`). It is a
  // boundary failure, and it settles as `error` on purpose (COR-1587): the run is over, the
  // message names the malformed field, and a rejection would leave the session `running` with no
  // terminal event. A summary this build cannot read at all (`UnsupportedRunResultVersionError`)
  // still rejects.
  const malformed = {
    schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
    runId: 'malformed',
    steps: 'not a number',
    content: '',
    parts: [],
    finishReason: 'stop-condition',
  };

  it('settles a fresh run as error with the field named', async () => {
    const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
    const terminalEvents = observeTerminalLifecycle(emitter);
    const engine = {
      start: async () => ({ result: () => Promise.resolve(malformed) }),
    } as unknown as RegistryAgnosticEngine;

    const result = await createDurableActiveRun(
      { engine, checkpointStore: emptyCheckpointStore },
      { runId: 'malformed', sessionId: 'malformed', options: runOptions(), emitter },
    ).result;

    expect(result.finishReason).toBe('error');
    expect(messageOf(result.error)).toContain('steps must be a finite number');
    expect(terminalEvents.map(({ type }) => type)).toEqual([
      RunErrorEvent.type,
      RunCompletedEvent.type,
    ]);
  });

  it('settles a reattached run as error with the field named', async () => {
    const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
    const terminalEvents = observeTerminalLifecycle(emitter);

    const result = await reattachDurableActiveRun(
      {
        engine: { get: async () => ({ status: 'running' }) } as never,
        checkpointStore: emptyCheckpointStore,
      },
      {
        runId: 'malformed',
        handle: { id: 'malformed', result: () => Promise.resolve(malformed) },
        emitter,
      },
    ).result;

    expect(result.finishReason).toBe('error');
    expect(messageOf(result.error)).toContain('steps must be a finite number');
    expect(terminalEvents.map(({ type }) => type)).toEqual([
      RunErrorEvent.type,
      RunCompletedEvent.type,
    ]);
  });
});

describe('a reattached run whose summary resolves as an error', () => {
  it('fires run.error then run.completed, as every failed run does', async () => {
    const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
    const terminalEvents = observeTerminalLifecycle(emitter);
    // The step's own `run.error` fired in the process that died, so the recovering process never
    // saw it: the summary is all that says the run failed.
    const summary = {
      schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
      runId: 'resolved-error',
      steps: 0,
      content: '',
      parts: [],
      finishReason: 'error',
      errorMessage: 'the model refused',
    };

    const result = await reattachDurableActiveRun(
      { engine: {} as RegistryAgnosticEngine, checkpointStore: emptyCheckpointStore },
      {
        runId: 'resolved-error',
        handle: { id: 'resolved-error', result: () => Promise.resolve(summary) },
        emitter,
      },
    ).result;

    expect(result.finishReason).toBe('error');
    expect(terminalEvents).toEqual([
      { type: RunErrorEvent.type, error: 'the model refused' },
      { type: RunCompletedEvent.type, finishReason: 'error', error: 'the model refused' },
    ]);
  });

  it('does not repeat a run.error the recovered step fired itself', async () => {
    const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
    const terminalEvents = observeTerminalLifecycle(emitter);
    const stepError = new AgentRunError('the model refused', { kind: 'generate', code: 'UNKNOWN' });
    const summary = {
      schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
      runId: 'step-error-after-replay',
      steps: 0,
      content: '',
      parts: [],
      finishReason: 'error',
      errorMessage: 'the model refused',
    };

    await reattachDurableActiveRun(
      { engine: {} as RegistryAgnosticEngine, checkpointStore: emptyCheckpointStore },
      {
        runId: 'step-error-after-replay',
        handle: {
          id: 'step-error-after-replay',
          result: () => {
            emitter.dispatch(new RunErrorEvent(0, stepError, 'generate'));
            return Promise.resolve(summary);
          },
        },
        emitter,
      },
    ).result;

    expect(terminalEvents.map(({ type }) => type)).toEqual([
      RunErrorEvent.type,
      RunCompletedEvent.type,
    ]);
  });
});

describe('a reattached run whose caller says whether the engine failed it before replay', () => {
  const rejection = () => new Error('x failed');

  it('settles as error when told it did not, whatever the engine state reads', async () => {
    const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
    const terminalEvents = observeTerminalLifecycle(emitter);

    const recoveredRun = reattachDurableActiveRun(
      {
        engine: { get: async () => ({ status: 'failed' }) } as never,
        checkpointStore: emptyCheckpointStore,
      },
      {
        runId: 'told-not-failed',
        handle: { id: 'told-not-failed', result: () => Promise.reject(rejection()) },
        emitter,
        failedBeforeReplay: false,
      },
    );
    const result = await recoveredRun.result;

    expect(result.finishReason).toBe('error');
    expect(terminalEvents.map(({ type }) => type)).toEqual([
      RunErrorEvent.type,
      RunCompletedEvent.type,
    ]);
  });

  it('stays write-free when told it did, whatever the engine state reads', async () => {
    const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
    const terminalEvents = observeTerminalLifecycle(emitter);
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      const result = await reattachDurableActiveRun(
        {
          engine: { get: async () => ({ status: 'running' }) } as never,
          checkpointStore: emptyCheckpointStore,
        },
        {
          runId: 'told-failed',
          handle: { id: 'told-failed', result: () => Promise.reject(rejection()) },
          emitter,
          failedBeforeReplay: true,
        },
      ).result;

      expect(result.finishReason).toBe('aborted');
      expect(terminalEvents).toEqual([]);
    } finally {
      console.error = originalConsoleError;
    }
  });
});

describe('a reattached run the recovery resolver already failed before replay', () => {
  it('fires no terminal lifecycle, because the resolver recorded the session as error', async () => {
    const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
    const terminalEvents = observeTerminalLifecycle(emitter);
    const originalConsoleError = console.error;
    const logs: string[] = [];
    console.error = (...args: unknown[]) => {
      logs.push(String(args[0]));
    };
    try {
      const result = await drivers[1]!.settle(
        new Error('Workflow "reattached-run" services unavailable: run not reconstructable'),
        emitter,
        {
          // The engine failed the run before the recovery hook handed it over, so by the time the
          // adapter reads its state the run is already terminal.
          get: async () => ({
            status: 'failed',
            error: 'Workflow "reattached-run" services unavailable: run not reconstructable',
          }),
        },
      );

      expect(result.finishReason).toBe('aborted');
      expect(terminalEvents).toEqual([]);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain('failed by the engine before replay');
    } finally {
      console.error = originalConsoleError;
    }
  });
});

describe('a run a real engine failed before replay', () => {
  it('stays write-free when the recovery resolver reports its services unavailable', async () => {
    const storage = new MemoryStorage();
    // Parks on a signal nobody sends, so the run is still in flight when the first engine goes
    // away and no timer decides whether the second engine finds it running.
    const runWorkflow = workflow({ name: 'agentRun' })
      .services<{ marker: number }>()
      .execute(async function* (ctx) {
        yield* ctx.waitForSignal('proceed');
        return 'unreachable';
      });
    const first = await createRunEngine({
      storage,
      runWorkflow,
      recover: false,
      startScheduler: false,
    });
    const runId = 'failed-before-replay';
    try {
      const handle = await first.engine.start(
        'agentRun',
        { runId },
        { id: runId, services: { marker: 1 } },
      );
      void handle.result().catch(() => {});
      for (let turn = 0; turn < 500; turn++) {
        const state = await first.engine.get(runId);
        if (state?.status === 'running') break;
        await yieldToPortableEventLoop();
      }
    } finally {
      first.engine[Symbol.dispose]();
    }

    const second = await createRunEngine({
      storage,
      runWorkflow,
      recover: false,
      startScheduler: false,
      resolveWorkflowServices: () => ({ status: 'unavailable', reason: 'run not reconstructable' }),
    });
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      const handles = await second.engine.recoverAll();
      expect(handles).toHaveLength(1);
      const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
      const terminalEvents = observeTerminalLifecycle(emitter);

      const recoveredRun = reattachDurableActiveRun(
        { engine: second.engine, checkpointStore: emptyCheckpointStore },
        { runId, handle: handles[0]!, emitter },
      );
      const result = await recoveredRun.result;

      expect(result.finishReason).toBe('aborted');
      expect(terminalEvents).toEqual([]);
    } finally {
      console.error = originalConsoleError;
      second.engine[Symbol.dispose]();
    }
  });
});

describe('a run the drivers leave write-free', () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly rejection: () => unknown;
    readonly engineOverrides?: Record<string, unknown>;
  }> = [
    {
      name: 'EngineDisposedError',
      rejection: () => Object.assign(new Error('engine disposed'), { code: 'EngineDisposedError' }),
    },
    {
      name: 'WorkflowCheckpointConflictError',
      rejection: () => new WorkflowCheckpointConflictError('write-free-conflict'),
    },
    {
      name: 'a run another engine owns',
      rejection: () => new Error('the other engine failed this run'),
      engineOverrides: { lostWorkflowClaim: () => true },
    },
  ];

  for (const { name, rejection, engineOverrides } of cases) {
    it(`fires no run.completed, run.aborted, or run.error for ${name}`, async () => {
      for (const driver of drivers) {
        const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
        const terminalEvents = observeTerminalLifecycle(emitter);

        const result = await driver.settle(rejection(), emitter, {
          ...stateAfterReplay,
          ...engineOverrides,
        });
        await macrotask();

        expect([driver.name, result.finishReason]).toEqual([driver.name, 'aborted']);
        expect([driver.name, terminalEvents]).toEqual([driver.name, []]);
      }
      expect(unhandledRejections).toEqual([]);
    });
  }
});
