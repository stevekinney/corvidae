import type { CheckpointStore } from '../durable/checkpoint-store';
import type { RegistryAgnosticEngine } from '../durable/create-run-engine';
import {
  AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
  type AgentRunWorkflowResult,
} from '../durable/run-workflow-result';

/**
 * Counts calls to an engine's `suspend`/`resume`/`cancel` so tests can prove
 * the durable preemption path was actually exercised (not an accidental
 * abort-and-rerun that happens to satisfy the higher-level assertions), and to
 * its two-phase start (`start`, `prepare`, and the prepared handle's
 * `launch`/`abandon`, COR-297), each recorded by workflow id.
 */
export interface EngineSpy {
  engine: RegistryAgnosticEngine;
  suspends: string[];
  resumes: string[];
  cancels: string[];
  starts: string[];
  prepares: string[];
  launches: string[];
  abandons: string[];
}

/**
 * Wraps a real or manual durable engine with spies on `suspend`, `resume`,
 * `cancel`, `start`, and `prepare` (whose returned handle's `launch` and
 * `abandon` are wrapped too). The engine is mutated in place so any object
 * already holding a reference (e.g. a scheduler) sees the wrapped methods.
 */
export function spyEngine(engine: RegistryAgnosticEngine): EngineSpy {
  const spy: EngineSpy = {
    engine,
    suspends: [],
    resumes: [],
    cancels: [],
    starts: [],
    prepares: [],
    launches: [],
    abandons: [],
  };
  const realSuspend = engine.suspend.bind(engine);
  const realResume = engine.resume.bind(engine);
  const realCancel = engine.cancel.bind(engine);

  engine.suspend = async (id: string) => {
    spy.suspends.push(id);
    return realSuspend(id);
  };
  engine.resume = async (id: string) => {
    spy.resumes.push(id);
    return realResume(id);
  };
  engine.cancel = async (id: string) => {
    spy.cancels.push(id);
    return realCancel(id);
  };
  // A fake engine that implements only the preemption methods is spied on those alone.
  if (typeof engine.start === 'function') {
    const realStart = engine.start.bind(engine);
    engine.start = async (...args: Parameters<RegistryAgnosticEngine['start']>) => {
      spy.starts.push(args[2]?.id ?? '');
      return realStart(...args);
    };
  }
  if (typeof engine.prepare === 'function') {
    const realPrepare = engine.prepare.bind(engine);
    engine.prepare = async (...args: Parameters<RegistryAgnosticEngine['prepare']>) => {
      spy.prepares.push(args[2]?.id ?? '');
      const prepared = await realPrepare(...args);
      return {
        id: prepared.id,
        launch: () => {
          spy.launches.push(prepared.id);
          return prepared.launch();
        },
        abandon: () => {
          spy.abandons.push(prepared.id);
          return prepared.abandon();
        },
      };
    };
  }

  return spy;
}

/**
 * COR-297 — gives a fake engine literal the two-phase start the durable driver
 * uses: its `prepare()` returns a handle whose `launch()` calls the literal's
 * own `start` with the same arguments, and whose `abandon()` resolves.
 */
export function withTwoPhaseStart<
  TEngine extends { start: (type: string, input: unknown, options?: never) => Promise<unknown> },
>(
  engine: TEngine,
): TEngine & {
  prepare: (
    type: string,
    input: unknown,
    options?: { id?: string },
  ) => Promise<{ id: string; launch: () => Promise<unknown>; abandon: () => Promise<void> }>;
} {
  return Object.assign(engine, {
    prepare: async (type: string, input: unknown, options?: { id?: string }) => ({
      id: options?.id ?? '',
      launch: () => engine.start(type, input, options as never),
      abandon: async () => {},
    }),
  });
}

/**
 * A lightweight manual durable engine for unit tests that do not need a real
 * Weft workflow. The engine's `start`/`resume` return a handle whose `result()`
 * resolves/rejects only when the test explicitly calls `resolveResult()` or
 * `rejectResult()`.
 *
 * Use this when you want to control exactly when the engine-level result
 * settles — for example, testing scheduler preemption edge cases where the
 * backing store would add noise.
 */
export function createManualDurableEngine(): {
  engine: RegistryAgnosticEngine;
  resolveResult: () => void;
  rejectResult: (error: unknown) => void;
  /** Ids passed to `prepare`, and to the prepared handle's `launch` and `abandon` (COR-297). */
  calls: { prepares: string[]; launches: string[]; abandons: string[] };
} {
  const calls = { prepares: [] as string[], launches: [] as string[], abandons: [] as string[] };
  let resolveResult: ((value: unknown) => void) | undefined;
  let rejectResult: ((error: unknown) => void) | undefined;
  const result = new Promise<unknown>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const engine = {
    start: async () => ({ result: () => result }),
    // COR-297 — the two-phase start: `launch()` returns the same handle `start` does.
    prepare: async (_type: string, _input: unknown, options?: { id?: string }) => {
      const id = options?.id ?? 'manual-run';
      calls.prepares.push(id);
      return {
        id,
        launch: async () => {
          calls.launches.push(id);
          return { result: () => result };
        },
        abandon: async () => {
          calls.abandons.push(id);
        },
      };
    },
    resume: async () => ({ result: () => result }),
    suspend: async () => {},
    get: async () => ({ status: 'suspended' }),
    cancel: async () => {
      rejectResult?.(new Error('Workflow cancelled'));
    },
  } as unknown as RegistryAgnosticEngine;

  return {
    engine,
    resolveResult: () =>
      resolveResult?.({
        schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
        runId: 'manual-run',
        steps: 0,
        content: 'manual',
        parts: [{ type: 'text', text: 'manual' }],
        finishReason: 'stop-condition',
      } satisfies AgentRunWorkflowResult),
    rejectResult: (error: unknown) => rejectResult?.(error),
    calls,
  };
}

/**
 * A minimal {@link CheckpointStore} stub for tests that use
 * {@link createManualDurableEngine}. The `loadCheckpoint` method returns a
 * zero-step cursor so the run-workflow resumes from step 0 without reading a
 * real backing store.
 */
export function createManualCheckpointStore(): CheckpointStore {
  return {
    loadCheckpoint: async (runId: string) => ({
      runId,
      cursor: {
        schemaVersion: 2,
        step: 0,
        totalUsage: { prompt: 0, completion: 0, total: 0 },
        lastContent: '',
        lastParts: [],
        finalRowIsReplacement: false,
        schemaAttempts: 0,
        lastAppliedConfigVersion: 0,
      },
      conversation: null,
      steps: [],
    }),
    saveCursor: async () => {},
    loadCursor: async () => null,
    saveConversation: async () => {},
    loadConversation: async () => null,
    saveStep: async () => {},
    loadSteps: async () => [],
    clear: async () => 0,
  };
}
