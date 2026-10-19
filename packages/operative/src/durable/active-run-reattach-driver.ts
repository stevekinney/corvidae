import type { RuntimeServices } from '@lostgradient/lifecycle';
import { isWeftErrorLike } from '@lostgradient/weft';
import { Conversation } from 'conversationalist';

import { AgentRunError } from '../errors';
import type { OperativeEventEmitter } from '../events';
import { UnsupportedRunResultVersionError } from '../run-envelope';
import { makeAbortResult } from '../run-lifecycle';
import { type RunResult } from '../types';
import type { DurableActiveRunContext } from './active-run-adapter';
import type { RecoveredRunHandle } from './active-run-event-surface';
import {
  announceRunFailure,
  classifyTimeoutMessage,
  finalizeRunResult,
  isFailureFinishReason,
  loadRunStateFromCheckpoint,
  lostRunToAnotherEngine,
  makeInterruptedRunResult,
  reconstructRunResult,
  reconstructTerminalRunError,
  settleRejectedRun,
} from './active-run-result-reconstruction';
import {
  type AgentRunWorkflowResult,
  normalizeAgentRunWorkflowResult,
} from './run-workflow-result';

/**
 * Whether the engine had already failed this run when the driver started. Reads the engine's own
 * state, tolerating a missing or throwing `get` the way {@link classifyTimeoutMessage} does: a
 * state that cannot be read is not evidence the run failed before replay.
 */
async function engineFailedRunBeforeReplay(
  context: DurableActiveRunContext,
  runId: string,
): Promise<boolean> {
  try {
    const state = await context.engine.get(runId);
    return state?.status === 'failed';
  } catch {
    return false;
  }
}

export async function driveReattachedRun(
  context: DurableActiveRunContext,
  runId: string,
  handle: RecoveredRunHandle,
  emitter: OperativeEventEmitter,
  abortOutcome: () => Promise<boolean> | undefined,
  reachability: { unreachable: boolean },
  runtime: RuntimeServices,
  failedBeforeReplayFromCaller?: boolean | undefined,
): Promise<RunResult> {
  const runStartTime = runtime.monotonic.now();
  // A caller that knows whether the engine failed this run before replay says so, and that is
  // used as given. Otherwise the engine's own state is the inference, read before anything below
  // awaits (see `engineFailedRunBeforeReplay`).
  const failedBeforeReplay =
    failedBeforeReplayFromCaller ?? engineFailedRunBeforeReplay(context, runId);
  // A step's own `run.error`, so a rejection that follows it is not announced a second time.
  let terminalErrorFromEvent: AgentRunError | undefined;
  emitter.addEventListener('run.error', (event) => {
    terminalErrorFromEvent = event.error;
  });

  let summary: AgentRunWorkflowResult;
  try {
    summary = normalizeAgentRunWorkflowResult(await handle.result());
  } catch (error) {
    // A summary this build cannot read is not the engine failing the run, so it is rethrown. A
    // current-version summary that breaks its own shape (`InvalidRunResultError`) settles as
    // `error` below on purpose, with the malformed field named: the run is over, and leaving its
    // session `running` with no terminal event would hide the corruption.
    if (error instanceof UnsupportedRunResultVersionError) {
      throw error;
    }
    // Another engine that reclaimed this run committed the terminal outcome this
    // rejection reports, and its own driver publishes it: stay write-free here,
    // exactly as on the success path below.
    if (lostRunToAnotherEngine(context, handle)) {
      reachability.unreachable = true;
      return makeInterruptedRunResult(new Conversation(undefined, { runtime }));
    }
    // An ADAPTER-INITIATED abort (bureau.abortRun → engine.cancel) that ACTUALLY
    // terminalized this run is a real terminal: fire `run.aborted` so the gateway
    // listener persists `aborted`, rather than leaving the session looking
    // `running` (committee round-2 finding 2). Classify as aborted ONLY when the
    // cancel succeeded (committee round-3 finding 1): if the cancel rejected, this
    // rejection came from a resolver/teardown failure that merely raced abort(),
    // and that owner's status must not be clobbered.
    const cancelSucceeded = await (abortOutcome() ?? Promise.resolve(false));
    if (cancelSucceeded) {
      // Reconstruct the checkpointed usage + steps (not a zeroed
      // `createRunState()`), so an abort that raced a run with prior checkpointed
      // steps reports the SAME accumulated usage the eventual terminal
      // `RunResult` would have — `loadRunStateFromCheckpoint` already tolerates a
      // failed/absent checkpoint by falling back to an empty run state +
      // conversation, satisfying the "must NOT suppress the abort lifecycle"
      // requirement (committee round-3 finding 2).
      const { runState, conversation } = await loadRunStateFromCheckpoint(context, runId, runtime);
      const lastStep = runState.steps[runState.steps.length - 1];
      return makeAbortResult(
        runState,
        conversation,
        undefined,
        emitter,
        lastStep ? lastStep.step + 1 : 0,
        'aborted',
        undefined,
        reconstructTerminalRunError({
          finishReason: 'aborted',
          steps: runState.steps.length,
          abortReason: 'aborted',
        }),
      );
    }
    // A `history.maxEvents` circuit-breaker (or a genuine execution-deadline
    // timeout) rejects `handle.result()` with a `WorkflowTimeoutError`. On a
    // RECOVERED run this is an ENGINE-policy terminal that fired AFTER recovery —
    // nothing else owns reconciling it (unlike a pre-replay resolver failure,
    // which the resolver already reconciled to `error`, or an EngineDisposedError
    // teardown). So, symmetric with `driveDurableRun`, classify it as `error` and
    // fire the terminal lifecycle here; otherwise the session is left stuck
    // `running` for a run that is actually terminal (Bugbot #38). `hooks: undefined`
    // per the reattach contract; the conversation comes from the checkpoint.
    const timedOut = isWeftErrorLike(error) && error.code === 'WorkflowTimeoutError';

    // EngineDisposedError = bureau teardown mid-resume (leave running for a later boot).
    // WorkflowCheckpointConflictError = another engine over the same store won a checkpoint
    // compare-and-swap for this run and owns its durable state, so this engine stopped driving it
    // and must not write a terminal over it.
    if (
      isWeftErrorLike(error) &&
      (error.code === 'EngineDisposedError' || error.code === 'WorkflowCheckpointConflictError')
    ) {
      // AB-204 AC8: closed() classifies this as unresolved/unreachable,
      // never failed — see `reachability`'s doc comment above.
      reachability.unreachable = true;
      return makeInterruptedRunResult(new Conversation(undefined, { runtime }));
    }

    // The engine terminally failed this run before replay, because the recovery resolver returned
    // services-unavailable. The resolver that reconciles a session records it as `error`, and a
    // terminal lifecycle here would write a second terminal save over that, so only log and
    // resolve quiet. The fact comes from the caller when it knows it. Without it, it is inferred
    // from the engine's state, which is read when this driver starts: a run that failed AFTER
    // replay reads `failed` too when the engine's storage serves the read late (an I/O reordering,
    // or a caller that reattaches a run that has already failed), and the inference then leaves
    // it unreported, the same as before this driver reported failures at all. A recovery path that
    // can tell the two apart should say so.
    if (!timedOut && (await failedBeforeReplay)) {
      console.error(
        `[operative] Reattached durable run "${runId}" was failed by the engine before replay, or failed before this process read its state: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return makeInterruptedRunResult(new Conversation(undefined, { runtime }));
    }

    // Any other rejection is the run ending after replay in this process, and nothing else owns
    // reporting it (COR-1587): an activity or workflow-body failure, such as a refused
    // `durable-run:` write, rejects with a plain `Error` that carries no code. Settle it as `error`
    // so the session, the run record, and attached streams end, rather than leaving them
    // `running` until the next boot. Same checkpointed-usage reconstruction as the abort branch
    // above, so a failure after prior checkpointed steps does not under-report accumulated usage.
    const { runState, conversation } = await loadRunStateFromCheckpoint(context, runId, runtime);
    return settleRejectedRun({
      rejection: error,
      ...(timedOut ? { message: await classifyTimeoutMessage(context, runId, error) } : {}),
      runState,
      conversation,
      hooks: undefined,
      emitter,
      runStartTime,
      runtime,
      terminalError: terminalErrorFromEvent,
    });
  }

  // COR-1390: `handle.result()` also settles when another engine reclaimed
  // this run after this one recovered it and finished it there; that engine
  // publishes the terminal lifecycle, so this one stays write-free.
  if (lostRunToAnotherEngine(context, handle)) {
    reachability.unreachable = true;
    return makeInterruptedRunResult(new Conversation(undefined, { runtime }));
  }

  const {
    result,
    runState,
    conversation: durableConversation,
  } = await reconstructRunResult(context, runId, summary, runtime);

  // A run that ended in failure announces it with `run.error` before `run.completed`, as every
  // failed run does, because that is what turns the run record to `error` and ends an attached
  // stream with `RUN_ERROR`. The step's own `run.error` fired in the process that died when the
  // run failed before the crash, so this one has not seen it: the summary is all that says so.
  // One this process saw is kept and not repeated.
  const reportedError = result.error instanceof AgentRunError ? result.error : undefined;
  const terminalError =
    terminalErrorFromEvent ??
    (isFailureFinishReason(result.finishReason)
      ? announceRunFailure(
          emitter,
          runState.steps.length,
          reportedError ??
            reconstructTerminalRunError({
              finishReason: result.finishReason,
              steps: runState.steps.length,
              errorMessage: summary.errorMessage,
              tripwire: summary.tripwire,
            }),
        )
      : reportedError);

  // `hooks: undefined` — the recovered run's `onRunComplete`/etc. hooks are
  // non-serializable run behavior; they were rebuilt by the resolver into
  // `ctx.services`, which the bureau never gets back. So reattach fires the
  // terminal EVENTS (which gateway's session-persistence listeners need) but not
  // the run HOOKS — matching the old `settleRecoveredRun`, which persisted the
  // session directly and never fired operative run hooks for a recovered run.
  return finalizeRunResult({
    finishReason: result.finishReason,
    runState,
    conversation: durableConversation,
    hooks: undefined,
    emitter,
    runStartTime,
    runtime,
    errorMessage: summary.errorMessage,
    abortReason: summary.abortReason,
    schemaValidation: summary.schemaValidation,
    output: summary.output,
    tripwire: summary.tripwire,
    terminalError,
  });
}

/**
 * Drive one durable run: fire the start lifecycle, start (or resume) the
 * workflow, await it, reconstruct the `RunResult`, and fire the completion
 * lifecycle — all via the shared `run-lifecycle.ts` so events/hooks match the
 * in-memory loop exactly.
 */
