import type { RuntimeServices } from '@lostgradient/lifecycle';
import { isWeftErrorLike } from '@lostgradient/weft';
import type { AnyToolbox } from 'armorer';
import { Conversation } from 'conversationalist';
import type { GeneratedMediaAdmission } from '../generated-media';

import { AgentRunError, toAgentRunError } from '../errors';
import type { OperativeEventEmitter } from '../events';
import { UnsupportedRunResultVersionError } from '../run-envelope';
import { makeErrorResult, startRunLifecycle } from '../run-lifecycle';
import { type RunOptions, type RunResult } from '../types';
import type { DurableActiveRunContext } from './active-run-adapter';
import {
  classifyTimeoutMessage,
  emptyRunState,
  finalizeRunResult,
  loadSettlementState,
  lostRunToAnotherEngine,
  makeInterruptedRunResult,
  reconstructRunResult,
  settleRejectedRun,
} from './active-run-result-reconstruction';
import {
  AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
  type AgentRunWorkflowResult,
  normalizeAgentRunWorkflowResult,
} from './run-workflow-result';
import type { DurableRunDeps, SessionInputPayload } from './types';

export async function driveDurableRun(
  context: DurableActiveRunContext,
  runId: string,
  sessionId: string,
  agentName: string,
  options: RunOptions,
  conversation: Conversation,
  signal: AbortSignal,
  emitter: OperativeEventEmitter,
  prompt: SessionInputPayload | undefined,
  onServices: ((services: DurableRunDeps) => void) | undefined,
  reachability: { unreachable: boolean },
  // AB-339: true when `abort()` was called before this run's deferred
  // microtask even fired — captured, once, as a synchronous snapshot in
  // that SAME microtask (see `drive()`'s call site for why a live
  // `signal.aborted` re-check here would be wrong: an abort that arrives
  // AFTER the microtask starts, while this function is still inside its
  // own `startRunLifecycle` await, already fires `engine.cancel()` via
  // `abort()`'s own `if (driveStarted)` branch, and that in-flight cancel
  // must still resolve against the record `engine.prepare` commits).
  abortedBeforeDrive: boolean,
  onStepToolbox: ((toolbox: AnyToolbox) => void) | undefined,
  runtime: RuntimeServices,
  hookTracker: (promise: Promise<unknown>) => void,
  // COR-713: receives every generated-media admission a step starts, so `closed()` can wait.
  admissionTracker: (admission: GeneratedMediaAdmission) => void,
  // AB-361: settles `ActiveRun.durablyStarted` — see that field's doc
  // comment and `createDurableActiveRun`'s own comment on these callbacks
  // for the call sites that reach them. Split resolve/reject (AB-361
  // review, PRRT_kwDORvupsc6gXHn8) so no failure value — including a
  // literal `undefined` throw/rejection — can be mistaken for success.
  resolveDurablyStarted: () => void,
  rejectDurablyStarted: (error: unknown) => void,
  tags?: readonly string[],
): Promise<RunResult> {
  const runStartTime = runtime.monotonic.now();
  const { hooks } = options;
  let terminalErrorFromEvent: AgentRunError | undefined;
  emitter.addEventListener('run.error', (event) => {
    terminalErrorFromEvent = event.error;
  });

  const errorResult = (error: unknown): RunResult =>
    makeErrorResult(
      emptyRunState(),
      conversation,
      hooks,
      emitter,
      terminalErrorFromEvent ?? toAgentRunError(error),
      options.costEstimation,
      undefined,
      hookTracker,
    );
  const abortedResult = (): RunResult =>
    finalizeRunResult({
      finishReason: 'aborted',
      runState: emptyRunState(),
      conversation,
      hooks,
      emitter,
      runStartTime,
      runtime,
      abortReason: typeof signal.reason === 'string' ? signal.reason : undefined,
      costEstimation: options.costEstimation,
      terminalError: terminalErrorFromEvent,
      hookTracker,
    });

  // RunStartedEvent + onRunStart (an onRunStart error fails the run). Settles to
  // `undefined`, or to the failure: `thrown` when `startRunLifecycle` itself threw
  // rather than the hook reporting an error.
  //
  // AB-361 review (codex P2 PRRT_kwDORvupsc6gXHn4): `startRunLifecycle` itself CAN
  // reject. `emitter` is a `CompletableEventTarget`
  // (`packages/lifecycle/src/completable.ts`), whose overridden `dispatchEvent`
  // calls the native dispatch first (which isolates a native `addEventListener`
  // throw, per spec) and THEN loops every `toObservable()`/`subscribe()`
  // subscriber directly, unguarded, so a synchronous throw from one of those
  // subscribers propagates out of `startRunLifecycle`'s own
  // `emitter?.dispatch(new RunStartedEvent(...))` call.
  const startLifecycle = async (): Promise<{ error: unknown; thrown: boolean } | undefined> => {
    try {
      const started = await startRunLifecycle(options, conversation, emitter, runtime);
      // COR-766: released when this run reaches a terminal state, so a registry
      // that outlives the run does not accumulate an observer per run. A throw
      // from `startRunLifecycle` itself never attached one.
      emitter.addEventListener('run.completed', started.stopObservingHookPlan, { once: true });
      emitter.addEventListener('run.error', started.stopObservingHookPlan, { once: true });
      emitter.addEventListener('run.aborted', started.stopObservingHookPlan, { once: true });
      return started.error === undefined ? undefined : { error: started.error, thrown: false };
    } catch (error) {
      return { error, thrown: true };
    }
  };

  // AB-339: an already-doomed run never durably starts at all: no `prepare()`,
  // so nothing to cancel and nothing for a later `Bureau.shutdown()` to race.
  // The start lifecycle still runs first (a caller listening for its events must
  // still see them), and a failing hook still wins over the abort. Otherwise the
  // run settles straight to an aborted `RunResult` through the same
  // `finalizeRunResult` every other terminal branch uses, so `run.aborted` fires
  // (and, per AC1, `onRunAbort`) exactly as it would for an ordinary abort.
  if (abortedBeforeDrive) {
    const failed = await startLifecycle();
    // AB-361: no durable write was attempted, so there is nothing for
    // `durablyStarted` to wait for, except that a throwing lifecycle rejects it
    // with that same error instead of reporting success.
    if (failed?.thrown === true) rejectDurablyStarted(failed.error);
    else resolveDurablyStarted();
    return failed === undefined ? abortedResult() : errorResult(failed.error);
  }

  // Pin the Weft workflow id to `runId` so `handle.id === runId`. This makes the
  // run's id its resume key (recoverAll surfaces handles keyed by it) and lets
  // boot recovery correlate handles to sessions by `handle.id` (see
  // `settleRecoveredRun`). Each `runId` is unique per run, so the duplicate-id
  // guard never trips on a fresh run.
  //
  // Hand the run's non-serializable behavior to the engine as its per-run
  // `services` value: the workflow body reads it as `ctx.services` (never
  // checkpointed), and on a cross-process recovery the engine re-provides it via
  // `resolveWorkflowServices`. Inject the combined signal so an abort() reaches
  // the running step, and the emitter so step events flow (inline mode).
  //
  // NOTE: `services` is Weft inline-execution-mode ONLY (0.2.1) — passing it
  // under `workflowExecutionMode: 'worker'` rejects at `engine.prepare`, because a
  // non-serializable value cannot cross to a Worker. This run engine is inline
  // by construction (tool execution runs in-process via `runStep`), so the
  // constraint is always satisfied here.
  const services: DurableRunDeps = {
    // Keep the resolved durable option on the per-run options object used by
    // each `runStep` invocation. `durableRun.agentName` is authoritative when
    // the caller supplied it separately from `RunOptions`; without copying it
    // here, step-synthesized tool events lose the run identity.
    options: { ...options, agentName, signal },
    toolbox: options.toolbox,
    emitter,
    onStepToolbox,
    admissionTracker,
  };
  // COR-297 — Weft's two-phase start. `prepare()` commits the run's durable
  // record (`pending`, not yet executing); that commit is the write
  // `ActiveRun.durablyStarted` gates on, so it resolves before the start
  // lifecycle runs and `createRun` never waits on the `onRunStart` hook. Only
  // after the lifecycle succeeds does `launch()` begin execution; a failing
  // lifecycle `abandon()`s the prepared record instead, so no workflow it
  // never meant to run is left behind (the 2026-09-08 coordinator ruling: a
  // hook failure never reaches an engine start).
  //
  // AB-361 review (copilot PRRT_kwDORvupsc6gWb3a, codex P2 PRRT_kwDORvupsc6gWc39):
  // both `onServices` (a caller-supplied callback, a genuinely reachable
  // synchronous throw) and `prepare()` itself (a real persistence failure, such
  // as a full disk) sit BEFORE that write, and both settle the gate with the
  // failure rather than leave a caller (bureau's `createRunFromRequest`) waiting
  // on it forever. The failure is routed through `makeErrorResult`, which
  // dispatches `RunCompletedEvent` synchronously, which is what bureau's own
  // `run.completed` listener needs to clean up the run's registration and
  // persist its terminal session state.
  let prepared: Awaited<ReturnType<typeof context.engine.prepare>>;
  try {
    // Give the caller a live reference to the EXACT object Weft will hand
    // back as `ctx.services` — see `DurableActiveRunOptions.onServices`.
    // Fires before `prepare()`, so a tool the caller wired against this
    // reference (e.g. `requestHumanInput`) can read it the moment `runStep`
    // executes, which is never before `launch()`.
    onServices?.(services);
    prepared = await context.engine.prepare(
      'agentRun',
      {
        runId,
        sessionId,
        // F2: thread agentName into the durable input so boot recovery can
        // identify which agent ran this workflow without reading the session store.
        agentName,
        prompt,
        maximumSteps: options.maximumSteps,
      },
      {
        id: runId,
        ...(tags !== undefined && tags.length > 0 ? { tags: [...tags] } : {}),
        services,
      },
    );
  } catch (error) {
    rejectDurablyStarted(error);
    return errorResult(error);
  }
  // Resolved for good: nothing after the commit rejects it.
  resolveDurablyStarted();

  const failed = await startLifecycle();
  if (failed !== undefined) {
    // Awaited, so the record reads `cancelled` by the time `result` settles. A
    // rejecting abandon never replaces the lifecycle's error.
    try {
      await prepared.abandon();
    } catch {
      // The record is left as Weft left it; the run's outcome is the lifecycle's error.
    }
    return errorResult(failed.error);
  }

  let handle: Awaited<ReturnType<typeof prepared.launch>>;
  try {
    handle = await prepared.launch();
  } catch (error) {
    // Read now: after the cancel below the record is `cancelled` either way, so
    // only the signal tells an abort that cancelled the prepared record (Weft
    // then refuses to launch it) from a launch that failed on its own. Weft marks
    // the prepared handle launched before any fallible work, so `abandon()`
    // cannot be used here; `cancel` terminalizes whatever state a failed launch
    // left behind.
    const aborted = signal.aborted;
    await context.engine.cancel(runId).catch(() => undefined);
    return aborted ? abortedResult() : errorResult(error);
  }

  let summary: AgentRunWorkflowResult;
  try {
    summary = normalizeAgentRunWorkflowResult(await handle.result());
  } catch (error) {
    // The engine was disposed while this run was still in flight — i.e. the
    // bureau (or process) is tearing down mid-run. This is the CRASH semantic,
    // not an abort: the run is abandoned FOR RECOVERY, so a fresh process can
    // resume it from its last checkpoint. We MUST NOT fire a terminal lifecycle
    // event here — `makeAbortResult`/`makeErrorResult` would drive gateway's
    // `once('run.aborted'/'completed')`, persist a terminal session status, and
    // the boot recovery resolver (`resolveWorkflowServices`, which only rebuilds
    // deps for sessions still marked `running`) would then never see the run and
    // recovery would never happen. So we resolve quietly with an interrupted-
    // shaped result and leave the session `running`. Structural code match (not
    // `instanceof`) to survive the module boundary — `isWeftErrorLike` narrows a
    // caught unknown without `instanceof`.
    //
    // `WorkflowCheckpointConflictError` takes the same path: another engine
    // over the same store won a checkpoint compare-and-swap for this run, so it
    // owns the run's durable state and terminal outcome. This engine stopped
    // driving the run and wrote nothing; firing a terminal lifecycle here would
    // persist an error/abort over the winner's run, so it must stay write-free.
    if (
      isWeftErrorLike(error) &&
      (error.code === 'EngineDisposedError' || error.code === 'WorkflowCheckpointConflictError')
    ) {
      // AB-204: closed() classifies this as unresolved/unreachable, never
      // completed/not-required — see `reachability`'s doc comment above.
      reachability.unreachable = true;
      return makeInterruptedRunResult(conversation);
    }
    // Another engine that took this run's claim committed the terminal outcome this
    // rejection reports (a timeout, cancel, or failure), and its own driver publishes
    // it: stay write-free here too, exactly as on the success path below.
    if (lostRunToAnotherEngine(context, handle)) {
      reachability.unreachable = true;
      return makeInterruptedRunResult(conversation);
    }
    // B6 (abort-into-generate): when abort() calls engine.cancel() in parallel
    // with abortController.abort(), engine.cancel() can win the race and set the
    // workflow's state to 'cancelled' before the in-flight generate() rejection
    // has a chance to settle the workflow to 'aborted'. Weft then rejects
    // handle.result() with a plain Error("Workflow cancelled") — not a WeftError
    // (no .code) — so isWeftErrorLike won't match it. Detect it by message and
    // treat it as a clean abort so the terminal lifecycle fires and the session
    // does not stay stuck 'running'. The abort reason (if any) lives on the
    // combined signal that was passed into this call.
    //
    // Reconstruct from the checkpoint so any steps completed before cancel() won
    // the race are preserved in the abort result — matching the normal durable
    // completion path. Fall back to an empty run state if the checkpoint is
    // unavailable (e.g. aborted before any step committed).
    if (error instanceof Error && error.message === 'Workflow cancelled') {
      let cancelledRunState = emptyRunState();
      let cancelledConversation = conversation;
      try {
        const reconstructed = await reconstructRunResult(
          context,
          runId,
          {
            schemaVersion: AGENT_RUN_WORKFLOW_RESULT_SCHEMA_VERSION,
            runId,
            steps: 0,
            content: '',
            parts: [],
            finishReason: 'aborted',
          },
          runtime,
        );
        cancelledRunState = reconstructed.runState;
        cancelledConversation = reconstructed.conversation;
      } catch {
        // Checkpoint unavailable — fall back to the seed conversation and an
        // empty run state (no steps committed before cancel won the race).
      }
      return finalizeRunResult({
        finishReason: 'aborted',
        runState: cancelledRunState,
        conversation: cancelledConversation,
        hooks,
        emitter,
        runStartTime,
        runtime,
        abortReason:
          signal.aborted && typeof signal.reason === 'string' ? signal.reason : undefined,
        costEstimation: options.costEstimation,
        terminalError: terminalErrorFromEvent,
        hookTracker,
      });
    }
    // `normalizeAgentRunWorkflowResult` rejects a RESOLVED result whose schema version this build
    // cannot read. That is not the engine failing the run, so it is not classified here: the
    // reattach driver rethrows it the same way. A summary of the current version that breaks its
    // own shape (`InvalidRunResultError`) is different on purpose: the run is over, and a
    // rejection would leave its session `running` with no terminal event, so it settles as
    // `error` below with the malformed field named in the message.
    if (error instanceof UnsupportedRunResultVersionError) throw error;

    // Anything that reaches here is the run ending in this process, and nothing else reports it
    // (COR-1587). A `history.maxEvents` circuit-breaker (or a genuine execution-deadline timeout)
    // rejects `handle.result()` with a `WorkflowTimeoutError`. The error code is
    // `'WorkflowTimeoutError'` (no 'd' — distinct from the `WorkflowTimedOutEvent` name) and
    // carries NO `terminationReason`, so the circuit-breaker-vs-deadline distinction must come
    // from the engine's stored state. An activity or workflow-body failure rejects with a plain
    // `Error` that carries no code. Either way the run is genuinely terminal (not
    // abandoned-for-recovery like EngineDisposedError), so settle it as `error` and fire the
    // terminal lifecycle here rather than rethrowing into the unawaited `.then()` chain (which
    // would surface as an unhandled rejection and leave the session stuck `running`). A
    // `run.error` a step already fired keeps its real error.
    const timedOut = isWeftErrorLike(error) && error.code === 'WorkflowTimeoutError';
    // From the checkpoint, so the terminal record keeps what the run committed before it failed.
    const settled = await loadSettlementState(context, runId, runtime, conversation);
    return settleRejectedRun({
      rejection: error,
      ...(timedOut ? { message: await classifyTimeoutMessage(context, runId, error) } : {}),
      runState: settled.runState,
      conversation: settled.conversation,
      hooks,
      emitter,
      runStartTime,
      runtime,
      costEstimation: options.costEstimation,
      terminalError: terminalErrorFromEvent,
      hookTracker,
    });
  }

  // COR-1390: `handle.result()` also settles when another engine took this
  // run's claim and finished it; that engine publishes the terminal lifecycle.
  if (lostRunToAnotherEngine(context, handle)) {
    reachability.unreachable = true;
    return makeInterruptedRunResult(conversation);
  }

  // The authoritative conversation on the durable path is the one rehydrated
  // from the checkpoint — the workflow mutates rehydrated snapshots per step,
  // never the input instance (which stays empty). Use the reconstructed one
  // for the result AND the completion lifecycle so they agree.
  const {
    result,
    runState,
    conversation: durableConversation,
  } = await reconstructRunResult(context, runId, summary, runtime);

  // Fire the completion lifecycle from the SAME functions the loop uses, keyed
  // on the durable run's finishReason. These run in-process on the launching
  // engine (inline mode) and are intentionally not checkpointed. The terminal
  // error message / abort reason are carried out of the workflow summary so the
  // emitted RunAborted/RunError events and gateway's `lastError` reflect the
  // real cause, not a synthetic placeholder.
  return finalizeRunResult({
    finishReason: result.finishReason,
    runState,
    conversation: durableConversation,
    hooks,
    emitter,
    runStartTime,
    runtime,
    errorMessage: summary.errorMessage,
    abortReason: summary.abortReason,
    schemaValidation: summary.schemaValidation,
    output: summary.output,
    tripwire: summary.tripwire,
    costEstimation: options.costEstimation,
    terminalError:
      terminalErrorFromEvent ?? (result.error instanceof AgentRunError ? result.error : undefined),
    hookTracker,
  });
}

/** A throwaway run state for the pre-step error path (no steps completed yet). */
