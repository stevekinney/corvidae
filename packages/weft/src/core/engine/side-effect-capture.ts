/**
 * Which branch of a running coordinator staged a side effect for the next checkpoint.
 *
 * A coordinator that commits while its branches still run (`ctx.all` committing a settled slot, a
 * document `parallel` committing a branch's step) must write each side effect a branch's operation
 * staged (a child's cancellation link, an activity's reconciliation receipt) in the commit that
 * records that operation's result: not earlier, where a crash would leave the effect without its
 * result, and not later, where it would leave the result without its effect. The workflow's staged
 * buffer is one per workflow, so the coordinator runs each branch operation inside a capture, and
 * {@link stageAtomicWorkflowCommitSideEffects} hands an effect staged inside one to that capture
 * instead of the buffer. The coordinator commits what a capture caught with the operation's result.
 *
 * The capture follows the operation's asynchronous work through `AsyncLocalStorage`. Where there
 * is none (a runtime without `node:async_hooks`), nothing is captured and every effect is staged
 * as before, for the commit that settles the coordinator.
 *
 * @module engine/side-effect-capture
 */

import type { BatchOperation, ConditionalBatchCondition } from '@lostgradient/storage';

type SideEffects = { conditions: ConditionalBatchCondition[]; operations: BatchOperation[] };

/** Receives an effect staged inside a capture: what it would have staged, and how. */
export type CapturedSideEffectSink = (
  sideEffects: SideEffects,
  workflowExecutionToken: string | undefined,
  bindToExecutionGeneration: boolean,
) => void;

type Capture = {
  readonly owner: object;
  readonly workflowId: string;
  readonly sink: CapturedSideEffectSink;
  readonly parent: Capture | undefined;
  open: boolean;
};

interface AsyncLocalStorageLike<Store> {
  getStore(): Store | undefined;
  run<Result>(store: Store, callback: () => Result): Result;
}

type AsyncLocalStorageConstructor = new <Store>() => AsyncLocalStorageLike<Store>;

let captureStorage: AsyncLocalStorageLike<Capture> | null | undefined;

function loadCaptureStorage(): AsyncLocalStorageLike<Capture> | null {
  if (captureStorage !== undefined) return captureStorage;
  const processValue =
    'process' in globalThis
      ? (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process
      : undefined;
  const asyncHooks =
    typeof processValue?.getBuiltinModule === 'function'
      ? (processValue.getBuiltinModule('node:async_hooks') as
          { AsyncLocalStorage?: AsyncLocalStorageConstructor } | undefined)
      : undefined;
  const AsyncLocalStorage = asyncHooks?.AsyncLocalStorage;
  captureStorage = AsyncLocalStorage === undefined ? null : new AsyncLocalStorage<Capture>();
  return captureStorage;
}

export type SideEffectCapture = {
  /** Run `execute` inside the capture: what it stages for `workflowId`, at any depth, is caught. */
  run<Result>(execute: () => Result): Result;
  /** Catch nothing more: an effect staged after the operation settled goes to an enclosing one. */
  close(): void;
};

/** Open a capture of what one branch operation of `workflowId` stages, for `sink`. */
export function captureSideEffects(
  owner: object,
  workflowId: string,
  sink: CapturedSideEffectSink,
): SideEffectCapture {
  const storage = loadCaptureStorage();
  const capture: Capture = {
    owner,
    workflowId,
    sink,
    parent: storage?.getStore(),
    open: true,
  };
  return {
    run: (execute) => (storage === null ? execute() : storage.run(capture, execute)),
    close: () => {
      capture.open = false;
    },
  };
}

/** The sink of the innermost open capture of `workflowId` around the caller, if any. */
export function capturedSideEffectSink(
  owner: object,
  workflowId: string,
): CapturedSideEffectSink | undefined {
  for (let capture = loadCaptureStorage()?.getStore(); capture; capture = capture.parent) {
    if (capture.open && capture.owner === owner && capture.workflowId === workflowId) {
      return capture.sink;
    }
  }
  return undefined;
}
