import { CompletableEventTarget, createDefaultRuntimeServices } from '@lostgradient/lifecycle';
import type { AnyToolbox, ToolboxEventMap } from 'armorer';
import { type AdmissionTracker, createAdmissionTracker } from '../admission-tracker';

import type { ChildRunRegistry } from '../child-run';
import type { CombinedOperativeEventMap, OperativeEventEmitter } from '../events';
import {
  ChildWorkflowAbortedEvent,
  ChildWorkflowCompletedEvent,
  ChildWorkflowFailedEvent,
  ChildWorkflowStartedEvent,
  HumanWaitParkedEvent,
  StepStartedEvent,
  ToolErrorBubbleEvent,
  ToolPolicyDeniedBubbleEvent,
  ToolProgressBubbleEvent,
  ToolSettledBubbleEvent,
  ToolStartedBubbleEvent,
} from '../events';
import type { ActiveRunLiveness } from '../liveness';
import { createToolboxEventForwarder } from '../toolbox-event-forwarding';
import type { DurableRunDeps } from './types';

/**
 * COR-2526 — declares a run's wait on the child runs it dispatched. A run whose tool call is a
 * subagent (or a peer call) is parked on that child for as long as the child runs, and the tool
 * call reports no progress of its own meanwhile: without the declaration, the tool-call watchdog
 * would read every delegating run as stalled. The child announces its start and its end on the
 * parent's emitter (`dispatchChildRun`), and the liveness holds the wait while any is outstanding.
 *
 * A subagent tool built without a `parentContext` dispatches no event onto the run's emitter: it
 * registers the child in the registry the run's per-execution context supplies, which is the run's
 * own `childRegistry`. Given that `registry` and the run's id, the wiring also holds the wait for
 * every child of this run that the registry reports running, so a delegation is a wait however the
 * tool was built. A child known by both routes is one wait. Returns the function that stops
 * listening.
 */
export function wireChildWaitLiveness(
  emitter: OperativeEventEmitter,
  liveness: ActiveRunLiveness,
  childRegistry?: { readonly registry: ChildRunRegistry | undefined; readonly runId: string },
): () => void {
  const onStarted = (event: ChildWorkflowStartedEvent) => {
    if (event.childRunId !== undefined) liveness.beginChildWait(event.childRunId);
  };
  const onEnded = (
    event: ChildWorkflowCompletedEvent | ChildWorkflowFailedEvent | ChildWorkflowAbortedEvent,
  ) => liveness.endChildWait(event.childRunId);
  emitter.addEventListener(ChildWorkflowStartedEvent.type, onStarted);
  emitter.addEventListener(ChildWorkflowCompletedEvent.type, onEnded);
  emitter.addEventListener(ChildWorkflowFailedEvent.type, onEnded);
  emitter.addEventListener(ChildWorkflowAbortedEvent.type, onEnded);

  // The registry's running children of this run, as last folded into the wait.
  const registryWaits = new Set<string>();
  const registry = childRegistry?.registry;
  const syncRegistryWaits = (): void => {
    if (registry === undefined) return;
    const running = new Set(
      registry
        .children()
        .filter((child) => child.parentId === childRegistry?.runId && child.status === 'running')
        .map((child) => child.id),
    );
    for (const id of running) {
      if (registryWaits.has(id)) continue;
      registryWaits.add(id);
      liveness.beginChildWait(id);
    }
    for (const id of [...registryWaits]) {
      if (running.has(id)) continue;
      registryWaits.delete(id);
      liveness.endChildWait(id);
    }
  };
  const registrySubscription = registry?.subscribeLiveness(syncRegistryWaits);
  syncRegistryWaits();

  return () => {
    registrySubscription?.unsubscribe();
    emitter.removeEventListener(ChildWorkflowStartedEvent.type, onStarted);
    emitter.removeEventListener(ChildWorkflowCompletedEvent.type, onEnded);
    emitter.removeEventListener(ChildWorkflowFailedEvent.type, onEnded);
    emitter.removeEventListener(ChildWorkflowAbortedEvent.type, onEnded);
  };
}

export function wireHumanWaitLiveness(
  emitter: OperativeEventEmitter,
  liveness: ActiveRunLiveness,
): () => void {
  const onHumanWaitParked = (event: HumanWaitParkedEvent) => {
    // AB-88: 'review' and 'signal' are distinct DeclaredWaitReasons even
    // though both surface through `human-wait.parked` today — a supplied
    // `prompt` (requestHumanInput's reviewer-facing text) distinguishes a
    // human review from a bare external signal. Matches
    // `session-handle.ts`'s identical derivation for `SessionHandle`'s own
    // liveness (`documentation/operative-type-safe-api.md`'s "Session
    // liveness" section) — the same event, the same rule, at a different
    // observation layer.
    liveness.beginWait({
      reason: event.prompt !== undefined ? 'review' : 'signal',
      dependency: event.signalName,
      wakeCondition: `signal:${event.signalName}`,
    });
  };
  const onStepStartedEndWait = () => liveness.endWait();
  emitter.addEventListener(HumanWaitParkedEvent.type, onHumanWaitParked);
  emitter.addEventListener(StepStartedEvent.type, onStepStartedEndWait);
  return () => {
    emitter.removeEventListener(HumanWaitParkedEvent.type, onHumanWaitParked);
    emitter.removeEventListener(StepStartedEvent.type, onStepStartedEndWait);
  };
}
/**
 * The minimal recovered-handle surface {@link reattachDurableActiveRun} needs: a
 * pinned id (== runId) and the settling `result()`. `engine.recoverAll()` returns
 * full `WorkflowHandle`s; this narrow shape avoids depending on Weft's invariant
 * `WorkflowHandle` generics (matching the `RegistryAgnosticEngine` widening convention).
 */
export interface RecoveredRunHandle {
  readonly id: string;
  result(): Promise<unknown>;
}

export interface RecoveredRunEventSurface {
  emitter: OperativeEventEmitter;
  abort: (reason?: string) => void;
  stopToolboxForward: () => void;
  /**
   * COR-713: collects the generated-media admissions the recovered run's steps start (it is
   * installed on `services.admissionTracker`), so the reattached `ActiveRun.closed()` waits for them.
   */
  admissions: AdmissionTracker;
}

/**
 * Build the live event surface for a recovered run during Weft's
 * `onRecoveredWorkflow` hook, before the recovered generator advances.
 */
export function createRecoveredRunEventSurface(
  services: DurableRunDeps,
  runId: string,
  agentName: string,
): RecoveredRunEventSurface {
  // AB-92/AB-252/AB-253: resolved exactly once, here — omitted, falls back
  // to the real globals, matching `createDurableActiveRun`'s own default.
  const runtime = services.options.runtime ?? createDefaultRuntimeServices();
  const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
  const abortController = new AbortController();
  services.options = {
    ...services.options,
    signal: services.options.signal
      ? AbortSignal.any([services.options.signal, abortController.signal])
      : abortController.signal,
  };
  services.emitter = emitter;
  // COR-121: enables the replay-aware human-wait park marker for this run.
  services.recoveredRun = true;
  const cleanups: Array<(() => void) | undefined> = [];

  let currentStep = 0;
  const stepListener = (event: StepStartedEvent) => {
    currentStep = event.step;
  };
  emitter.addEventListener(StepStartedEvent.type, stepListener);
  cleanups.push(() => emitter.removeEventListener(StepStartedEvent.type, stepListener));

  // AB-294: the curated tool.* bubble listeners move onto the same per-step
  // subscription `toolboxForwarder` uses for the low-level `toolbox.*`
  // forward (AB-239) — `attachToolboxCuratedListeners` below is passed to
  // `createToolboxEventForwarder` as its `attachCurated` argument.
  //
  // AB-290: mirrors `createDurableActiveRun`'s identically-named helper —
  // see its comment.
  const isOwnEvent = (event: { ownerId?: string | undefined }): boolean => event.ownerId === runId;
  const attachToolboxCuratedListeners = (toolboxInstance: AnyToolbox): (() => void) => {
    const toolboxWithListener = toolboxInstance as unknown as {
      addEventListener?:
        | (<K extends keyof ToolboxEventMap>(
            type: K,
            listener: (event: ToolboxEventMap[K]) => void,
            options?: AddEventListenerOptions,
          ) => () => void)
        | undefined;
    };
    if (!toolboxWithListener.addEventListener) return () => {};
    const addListener = toolboxWithListener.addEventListener.bind(toolboxWithListener);
    const toolboxCleanups = [
      addListener('execute-start', (event) => {
        if (!isOwnEvent(event)) return;
        emitter.dispatchEvent(
          new ToolStartedBubbleEvent(
            { agentName, runId, step: currentStep },
            {
              toolName: event.call.name,
              toolCallId: event.call.id,
              params: event.params,
              startedAt: runtime.clock.now(),
            },
          ),
        );
      }),
      addListener('settled', (event) => {
        if (!isOwnEvent(event)) return;
        if (services.deferredChildCallIds?.has(event.call.id) === true) return;
        const hasError = event.error !== undefined;
        emitter.dispatchEvent(
          new ToolSettledBubbleEvent(
            { agentName, runId, step: currentStep },
            {
              toolName: event.call.name,
              toolCallId: event.call.id,
              status: event.status,
              result: event.result,
              error: event.error,
            },
          ),
        );
        if (hasError) {
          emitter.dispatchEvent(
            new ToolErrorBubbleEvent(
              { agentName, runId, step: currentStep },
              {
                toolName: event.call.name,
                toolCallId: event.call.id,
                error: event.error,
              },
            ),
          );
        }
      }),
      addListener('progress', (event) => {
        if (!isOwnEvent(event)) return;
        emitter.dispatchEvent(
          new ToolProgressBubbleEvent(
            { agentName, runId, step: currentStep },
            {
              toolName: event.call.name,
              toolCallId: event.call.id,
              percent: event.percent,
              message: event.message,
            },
          ),
        );
      }),
      addListener('policy-denied', (event) => {
        emitter.dispatchEvent(
          new ToolPolicyDeniedBubbleEvent(
            { agentName, runId, step: currentStep },
            {
              toolName: event.call.name,
              toolCallId: event.call.id,
              reason: event.reason,
            },
          ),
        );
      }),
    ];
    return () => {
      for (const cleanup of toolboxCleanups) cleanup?.();
    };
  };

  // AB-239: same base-plus-per-step forwarding as the fresh-start path
  // (`createDurableActiveRun` → `driveDurableRun`), wired directly onto the
  // recovered `services` object rather than threaded through a `drive()` call —
  // the recovered generator reads `services.onStepToolbox` via `ctx.services`
  // on its very next step. Chains any `onStepToolbox` the resolver already
  // installed on `services` rather than clobbering it, so this forwarder can
  // never silently drop another caller's per-step toolbox instrumentation.
  // Since AB-294, `attachToolboxCuratedListeners` above rides the same
  // base-plus-swap bracket as the low-level `toolbox.*` forward.
  const priorOnStepToolbox = services.onStepToolbox;
  const toolboxForwarder = createToolboxEventForwarder(
    services.toolbox,
    emitter,
    attachToolboxCuratedListeners,
  );
  services.onStepToolbox = (toolbox) => {
    priorOnStepToolbox?.(toolbox);
    toolboxForwarder.onStepToolbox(toolbox);
  };
  cleanups.push(() => toolboxForwarder.stop());

  const admissions = createAdmissionTracker();
  const priorAdmissionTracker = services.admissionTracker;
  services.admissionTracker = (admission) => {
    priorAdmissionTracker?.(admission);
    admissions.track(admission);
  };

  return {
    emitter,
    admissions,
    stopToolboxForward: () => {
      for (const cleanup of cleanups) cleanup?.();
    },
    abort: (reason?: string) => abortController.abort(reason),
  };
}
