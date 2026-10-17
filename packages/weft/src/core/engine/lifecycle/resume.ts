/**
 * `engine.resume(id)` / `recoverAll()`'s standalone-replay-from-storage entry
 * point. The actual work — load tracking/checkpoint/registration state,
 * prepare the resume, and relaunch inline or in a worker — lives in
 * `resume-body.ts`'s `performResumeAfterClaimAcquired` (split out to stay
 * under this repository's 500-line implementation-file ceiling once the
 * WFT-134 claim-release wrapping below was added). This file's own job is
 * just: load and validate state, acquire a claim if this run doesn't already
 * hold one, and release a claim it freshly acquired if the resume turns out
 * not to succeed after all — UNLESS `options.deferClaimReleaseOnRejection`
 * asks this call to leave that claim installed for its caller instead (see
 * {@link ResumeFromStorageOptions}).
 *
 * @module core/engine/lifecycle/resume
 */

import { KEYS } from '../../../storage/interface.ts';
import { abandonExecutionAttempt, isGenerationAbandoned } from '../execution-attempts.ts';
import type { WorkflowHandle } from '../handles.ts';
import type { EngineInternals } from '../internals.ts';
import { decodeWorkflowState } from '../validation.ts';
import { performResumeAfterClaimAcquired } from './resume-body.ts';
import type { LifecycleCallbacks, RecoverAllOptions } from './shared.ts';
import {
  acquireStandaloneClaimBeforeResume,
  releaseFreshlyAcquiredResumeClaim,
  type StandaloneClaimAcquireResult,
} from './standalone-claim-acquire.ts';

/**
 * An out-parameter this call populates with the epoch of a claim it freshly
 * acquired, so a caller using `deferClaimReleaseOnRejection` can release that
 * EXACT generation itself once it is done using it (WFT-134 review round 2,
 * issue D). Left at `{ epoch: null }` when no fresh acquisition happened —
 * folding disabled, no registry, the cached claim matched, or acquisition
 * itself threw `WorkflowClaimUnavailableError` before returning.
 */
export type FreshResumeClaimTracker = { epoch: number | null };

/** Options for {@link resumeWorkflowFromStorage}. */
export type ResumeFromStorageOptions = {
  /**
   * `true` for `recoverAll()`'s per-entry recovery loop (WFT-134 issue D):
   * its own `recoverEntryOrIsolateFailure` isolates several errors into a
   * fenced `failWorkflowForXxx()` commit that needs a freshly-acquired claim
   * to still be installed, so this call must NOT release on rejection —
   * instead it records the acquired epoch in `freshClaimTracker` and lets the
   * caller release once its own isolated-failure handling is done. Default
   * (`false`/omitted) is correct for an explicit `engine.resume()` caller,
   * which has nothing further to do with the claim and must release
   * immediately on any rejection.
   */
  deferClaimReleaseOnRejection?: boolean;
  /** Populated with the freshly-acquired epoch, if any — see {@link FreshResumeClaimTracker}. */
  freshClaimTracker?: FreshResumeClaimTracker;
  /**
   * `true` only for the wake of an inline-parked run (`resumeParkedInlineWorkflow`): skips the
   * eager-type recovery revision check, which belongs to the recovery entry points.
   */
  skipEagerRevisionCheck?: boolean;
};

/** Populate `tracker.epoch` from a fresh acquisition — split out to keep `resumeWorkflowFromStorage`'s complexity under this repository's ceiling. */
function recordFreshClaimEpoch(
  acquireResult: StandaloneClaimAcquireResult,
  tracker: FreshResumeClaimTracker | undefined,
): void {
  if (acquireResult.freshlyAcquired && tracker !== undefined) {
    tracker.epoch = acquireResult.epoch;
  }
}

/**
 * Release a freshly-acquired claim on rejection, unless the caller deferred
 * that release — see `ResumeFromStorageOptions.deferClaimReleaseOnRejection`
 * (WFT-134). Split out for the same complexity-ceiling reason as {@link recordFreshClaimEpoch}.
 */
async function releaseFreshClaimOnRejectionUnlessDeferred(
  internals: EngineInternals,
  workflowId: string,
  acquireResult: StandaloneClaimAcquireResult,
  deferRelease: boolean | undefined,
): Promise<void> {
  if (acquireResult.freshlyAcquired && deferRelease !== true) {
    await releaseFreshlyAcquiredResumeClaim(internals, workflowId, acquireResult.epoch);
  }
}

/**
 * Resume `workflowId` from durable storage, joining a resume of it that is already in flight in
 * this engine and has not yet adopted the checkpoint.
 *
 * Until that adoption the engine holds no local checkpoint and no inline execution for the run, so
 * `recoverAll()`'s preflight and `resume()`'s local-ownership check both treat it as idle. A
 * resume parked in `resolveWorkflowServices` (a reclaim held while a Bureau finishes composing,
 * say) would otherwise be followed by a second resume of the same run that drives it in parallel;
 * the later checkpoint commit then loses its compare-and-swap and abandons the run. The joiner
 * receives the in-flight resume's handle or rejection. Its own `onRecoveredWorkflow` hook does not
 * fire for that run, because the run was recovered once, by the resume it joined.
 */
export function resumeWorkflowFromStorage(
  internals: EngineInternals,
  workflowId: string,
  dispatchResumedEvent: boolean,
  callbacks: LifecycleCallbacks,
  onRecoveredWorkflow?: RecoverAllOptions['onRecoveredWorkflow'],
  options?: ResumeFromStorageOptions,
): Promise<WorkflowHandle> {
  const inFlight = internals.resumesAwaitingAdoption.get(workflowId);
  if (inFlight !== undefined) return inFlight;
  const resuming = resumeWorkflowFromStorageOnce(
    internals,
    workflowId,
    dispatchResumedEvent,
    callbacks,
    onRecoveredWorkflow,
    options,
  );
  internals.resumesAwaitingAdoption.set(workflowId, resuming);
  // A resume that settles before adopting the checkpoint (a rejection, usually) leaves the map
  // here. The cleanup hangs off a side branch so the caller's promise settles in exactly as many
  // microtask turns as before: settlement order on this path is load-bearing (see COR-1425).
  const forget = (): void => {
    if (internals.resumesAwaitingAdoption.get(workflowId) === resuming) {
      internals.resumesAwaitingAdoption.delete(workflowId);
    }
  };
  resuming.then(forget).catch(forget);
  return resuming;
}

async function resumeWorkflowFromStorageOnce(
  internals: EngineInternals,
  workflowId: string,
  dispatchResumedEvent: boolean,
  callbacks: LifecycleCallbacks,
  onRecoveredWorkflow?: RecoverAllOptions['onRecoveredWorkflow'],
  options?: ResumeFromStorageOptions,
): Promise<WorkflowHandle> {
  // Load workflow state
  const stateBytes = await internals.storage.get(KEYS.workflow(workflowId));
  if (!stateBytes) {
    throw new Error(`Workflow "${workflowId}" not found in storage`);
  }

  const state = decodeWorkflowState(stateBytes);
  if (state.status !== 'running' && state.status !== 'suspended') {
    throw new Error(
      `Cannot resume workflow "${workflowId}": status is "${state.status}", expected "running" or "suspended"`,
    );
  }

  const acquireResult = await acquireStandaloneClaimBeforeResume(internals, workflowId);
  recordFreshClaimEpoch(acquireResult, options?.freshClaimTracker);
  // Relaunching ends the abandoned attempt as soon as the checkpoint is adopted and begins a
  // new one, before the remaining resume steps run; restore the abandonment if any of them fail.
  const token = state.workflowExecutionToken;
  const wasAbandoned = isGenerationAbandoned(internals, workflowId, token);

  try {
    return await performResumeAfterClaimAcquired(
      internals,
      workflowId,
      state,
      dispatchResumedEvent,
      callbacks,
      onRecoveredWorkflow,
      options?.skipEagerRevisionCheck,
    );
  } catch (error) {
    if (wasAbandoned) abandonExecutionAttempt(internals, workflowId, token);
    // WFT-134: release a freshly-acquired claim (see its doc) on any
    // rejection above, notably `performSerializedResume`'s status/generation
    // re-check — unless the caller asked to defer that release (see
    // `ResumeFromStorageOptions`).
    await releaseFreshClaimOnRejectionUnlessDeferred(
      internals,
      workflowId,
      acquireResult,
      options?.deferClaimReleaseOnRejection,
    );
    throw error;
  }
}
