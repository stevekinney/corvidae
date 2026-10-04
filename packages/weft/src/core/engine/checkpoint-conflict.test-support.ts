/**
 * Fixtures shared by the checkpoint-conflict test files: storage wrappers that record the
 * writes an engine attempts, a collector for the operator warning, and helpers that drive a
 * run into a lost checkpoint compare-and-swap, hold a terminal failure in flight, and tell a
 * `result()` that rejected from one that is still pending.
 */
import { KEYS, type BatchOperation, type Storage } from '../../storage/interface.ts';
import {
  createDeferred,
  waitForCondition,
  yieldToEventLoop,
} from '../../testing/fake-timers.test-support.ts';
import { rejectionOf } from '../../testing/promise-outcome.test-support.ts';
import { decode } from '../codec/api.ts';
import { workflow, type WorkflowContext, type WorkflowState } from '../types.ts';
import { abandonWorkflowAfterCheckpointConflict } from './checkpoint-conflict-abandon.ts';
import {
  WeftWorkflowCheckpointConflictWarning,
  WorkflowCheckpointConflictError,
} from './checkpoint-conflict-error.ts';
import type { Engine } from './index.ts';
import { getInternals, type EngineInternals } from './internals.ts';

export const WRITE_METHODS = ['put', 'delete', 'deletePrefix', 'batch', 'conditionalBatch'];

export function writeOperations(
  name: string,
  argumentsList: readonly unknown[],
): readonly BatchOperation[] | null {
  if (name === 'batch') return argumentsList[0] as BatchOperation[];
  if (name === 'conditionalBatch') return argumentsList[1] as BatchOperation[];
  return null;
}

/** Wrap `base` so every write the engine attempts is recorded by method name. */
export function recordWrites(base: Storage) {
  const writes: string[] = [];
  const storage = new Proxy(base, {
    get(target, property) {
      const original: unknown = Reflect.get(target, property, target);
      if (typeof original !== 'function') return original;
      if (WRITE_METHODS.includes(String(property))) {
        return (...argumentsList: unknown[]) => {
          writes.push(String(property));
          return original.apply(target, argumentsList);
        };
      }
      return original.bind(target);
    },
  });
  return { storage, writes };
}

/**
 * Collect conflict warnings. `process.emitWarning` delivers on a later tick, so
 * `received` resolves once `expected` of them have actually arrived.
 */
export function collectConflictWarnings(expected = 1) {
  const warnings: WeftWorkflowCheckpointConflictWarning[] = [];
  const reached = createDeferred();
  const listener = (warning: Error): void => {
    if (!(warning instanceof WeftWorkflowCheckpointConflictWarning)) return;
    warnings.push(warning);
    if (warnings.length >= expected) reached.resolve();
  };
  process.on('warning', listener);
  return { warnings, received: reached.promise, stop: () => process.off('warning', listener) };
}

export async function readStatus(
  base: Storage,
  workflowId: string,
): Promise<WorkflowState['status']> {
  return (decode((await base.get(KEYS.workflow(workflowId)))!) as WorkflowState).status;
}

export function tokenOf(internals: EngineInternals, workflowId: string): string | undefined {
  return internals.checkpoints.get(workflowId)?.workflowExecutionToken;
}

/** Report the loss of whichever generation the engine currently holds for the workflow. */
export function loseGeneration(internals: EngineInternals, workflowId: string): void {
  abandonWorkflowAfterCheckpointConflict(
    internals,
    new WorkflowCheckpointConflictError(workflowId, {
      workflowExecutionToken: tokenOf(internals, workflowId),
    }),
  );
}

/**
 * The rejection reason of `promise`, or `'pending'` when it has not settled after one
 * event-loop turn. Lets a regression test fail on a result() that hangs without
 * waiting out the test timeout.
 */
export async function rejectionOrPending(promise: Promise<unknown>): Promise<unknown> {
  return await Promise.race([
    rejectionOf(promise),
    yieldToEventLoop().then(() => 'pending' as const),
  ]);
}

export const parkedOnSignal = (name: string) =>
  workflow({ name }).execute(async function* (context: WorkflowContext) {
    return yield* context.waitForSignal<string>('go');
  });

export async function startParked(engine: Engine, name: string, id: string) {
  engine.register(parkedOnSignal(name));
  const handle = await engine.start(name, null, { id });
  await waitForCondition(() => getInternals(engine).parkedInlineWorkflows.has(id), {
    label: `${id} parked on its signal`,
  });
  return handle;
}

export const noCallbacks = new Proxy({}, { get: () => () => {} }) as never;

/**
 * Hold the next `failWorkflow` for `workflowId` at its first storage read, as an interleaving
 * turn would, and record the writes the engine attempts from then on.
 */
export function holdFailureAtItsFirstRead(
  internals: EngineInternals,
  base: Storage,
  workflowId: string,
) {
  const reachedRead = createDeferred();
  const releaseRead = createDeferred();
  const watched = recordWrites(base);
  let held = false;
  internals.storage = new Proxy(watched.storage, {
    get(target, property) {
      const original: unknown = Reflect.get(target, property, target);
      if (typeof original !== 'function') return original;
      if (property === 'get') {
        return async (key: string) => {
          if (key === KEYS.attribute(workflowId) && !held) {
            held = true;
            reachedRead.resolve();
            await releaseRead.promise;
          }
          return original.call(target, key);
        };
      }
      return original.bind(target);
    },
  });
  return {
    reached: reachedRead.promise,
    release: () => releaseRead.resolve(),
    writes: watched.writes,
  };
}
