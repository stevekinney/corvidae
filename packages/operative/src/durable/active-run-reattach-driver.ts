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
  classifyTimeoutMessage,
  finalizeRunResult,
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
): Promise<RunResult> {
  const runStartTime = runtime.monotonic.now();
  // Started before anything below awaits, so it reads the state as the recovery hook handed the
  // run over (see `engineFailedRunBeforeReplay`).
  const failedBeforeReplay = engineFailedRunBeforeReplay(context, runId);

  let summary: AgentRunWorkflowResult;
  try {
    summary = normalizeAgentRunWorkflowResult(await handle.result());
  } catch (error) {
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

    // The engine terminally failed this run before replay because the recovery resolver returned
    // services-unavailable, and the resolver ALREADY reconciled that session to `error`. Firing a
    // terminal lifecycle here would write a second terminal save over what the resolver owns, so
    // only log and resolve quiet. The state read began when this driver started, which is when
    // the recovery hook handed the run over; a failure after replay began cannot have reached
    // `failed` before then, except in the few microtasks between that hand-over and the read.
    if (!timedOut && (await failedBeforeReplay)) {
      console.error(
        `[operative] Reattached durable run "${runId}" was failed by the engine before replay: ${
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
    if (timedOut) {
      return finalizeRunResult({
        finishReason: 'error',
        runState,
        conversation,
        hooks: undefined,
        emitter,
        runStartTime,
        runtime,
        errorMessage: await classifyTimeoutMessage(context, runId, error),
      });
    }
    return settleRejectedRun({
      rejection: error,
      runState,
      conversation,
      hooks: undefined,
      emitter,
      runStartTime,
      runtime,
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
    terminalError: result.error instanceof AgentRunError ? result.error : undefined,
  });
}

/**
 * Drive one durable run: fire the start lifecycle, start (or resume) the
 * workflow, await it, reconstruct the `RunResult`, and fire the completion
 * lifecycle — all via the shared `run-lifecycle.ts` so events/hooks match the
 * in-memory loop exactly.
 */
