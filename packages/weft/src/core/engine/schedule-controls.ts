/**
 * The two things a person does to a schedule's cadence without changing its definition (COR-1829):
 * skip the next run, and start one now.
 */

import { encode } from '../codec.ts';
import { ScheduleAttemptedEvent, ScheduleSkippedEvent } from '../events.ts';
import type { ScheduleSkipOptions, ScheduleState, ScheduleTriggerResult } from '../types.ts';
import type { EngineInternals } from './internals.ts';
import { startUnderScheduleRead } from './schedule-conditioned-start.ts';
import { resolveEffectiveScheduleFireAt } from './schedule-jitter.ts';
import { ScheduleOccurrenceNotNextError } from './schedule-occurrence-not-next-error.ts';
import { findFiringScheduleOccurrence, getNextScheduleOccurrence } from './schedule-occurrence.ts';
import type { ScheduledRunStartOptions } from './schedule-run.ts';
import {
  runIsolatedScheduleStateOperation,
  runScheduleTransition,
} from './schedule-state-operations.ts';
import {
  type LoadedScheduleState,
  requireScheduleState,
  ScheduleReadConditionLostError,
  scheduleReadConditions,
} from './schedule-state-read.ts';
import { scheduleLateAfterMilliseconds } from './schedule-timer.ts';
import type { ScheduleCallbacks } from './schedules.ts';
import { clearScheduleCurrentWorkflow } from './state-utilities.ts';
import { writeScheduleState } from './storage-io.ts';
import {
  coerceExpectedScheduleRevision,
  coerceScheduleId,
  coerceScheduleOccurrence,
} from './validation/schedule.ts';

/** `state` without the skip a person asked for, which a change of cadence or status ends. */
export function withoutSkip(state: ScheduleState): ScheduleState {
  const { skipUntil: _ended, ...rest } = state;
  return rest;
}

/**
 * Skips the next occurrence that would start a run (COR-1829). It is bookkeeping, as a fire is:
 * `revision`, `nextFireAt` and the timer stay as they are, so a timer tick in flight goes on and
 * honors the skip instead of being stopped by it. Skipping again before that occurrence has passed
 * changes nothing.
 *
 * `options.occurrence` (COR-1985) names the run the caller means. A fire moves neither `revision` nor
 * `status`, so `expectedRevision` cannot catch one between the caller's read and this write; the
 * occurrence is compared here, against the next real run of the schedule as the guarded write reads
 * it, and refused with {@link ScheduleOccurrenceNotNextError} unless it is that run or the one
 * already skipped. A write that loses its conditions reads the schedule again, so the comparison is
 * always made against the bytes the skip lands on.
 */
export async function skipNextScheduleOccurrence(
  internals: EngineInternals,
  scheduleId: string,
  options?: ScheduleSkipOptions,
): Promise<void> {
  const normalizedScheduleId = coerceScheduleId(scheduleId, 'scheduleId');
  const expectedRevision = coerceExpectedScheduleRevision(options?.expectedRevision);
  const occurrence = coerceScheduleOccurrence(options?.occurrence);
  await runScheduleTransition(
    internals,
    normalizedScheduleId,
    expectedRevision,
    async (state, readConditions) => {
      if (state.status !== 'active' || state.nextFireAt === null) {
        throw new Error(
          `Schedule "${normalizedScheduleId}" is ${state.status} and has no next occurrence to skip`,
        );
      }
      const now = internals.options.getNow();
      const skipUntil = findFiringScheduleOccurrence(
        state,
        firstOccurrenceStillToFire(internals, { ...state, nextFireAt: state.nextFireAt }, now),
      );
      if (
        occurrence !== undefined &&
        (occurrence !== skipUntil ||
          (state.skipUntil !== undefined && state.skipUntil > occurrence))
      ) {
        throw new ScheduleOccurrenceNotNextError(normalizedScheduleId, occurrence, skipUntil);
      }
      if (state.skipUntil !== undefined && state.skipUntil >= skipUntil) return;
      await writeScheduleState(
        internals,
        { ...state, skipUntil, updatedAt: now },
        { includeTimer: false, extraConditions: readConditions },
      );
    },
  );
}

/**
 * The first occurrence, from `nextFireAt` on, that has neither started a run nor will be counted
 * missed: the one the person means by "the next run".
 *
 * - A backfill tick that is catching up writes each run it starts (`lastFireAt`) and moves
 *   `nextFireAt` only after the last one, so while it is going the next is the one after
 *   `lastFireAt`.
 * - A non-backfill schedule whose `nextFireAt` is already later than a tick may reach it is
 *   counted missed up to now by the tick that reaches it, so the next is the first after now.
 * - Otherwise it is `nextFireAt`, even when that has passed: a jittered fire, or one inside the
 *   poll window, is due but has not started a run.
 */
function firstOccurrenceStillToFire(
  internals: EngineInternals,
  state: ScheduleState & { nextFireAt: number },
  now: number,
): number {
  const { nextFireAt, lastFireAt } = state;
  if (lastFireAt !== undefined && lastFireAt >= nextFireAt) {
    return getNextScheduleOccurrence(state, lastFireAt);
  }
  const overdueBy = now - resolveEffectiveScheduleFireAt(state, nextFireAt);
  if (!state.backfill && overdueBy > scheduleLateAfterMilliseconds(internals)) {
    return getNextScheduleOccurrence(state, now);
  }
  return nextFireAt;
}

/**
 * Starts one run of the schedule now (COR-1829), under its overlap policy, and tells what the
 * policy did with it. The run is not an occurrence of the cadence: `nextFireAt`, `lastFireAt` and
 * `revision` stay as they are, and the run's schedule metadata carries `manual: true`. A paused
 * schedule can be run; a cancelled one cannot.
 *
 * Every write it makes is conditioned on the schedule as it read it, and a run it starts is
 * committed in one batch with the schedule that names it. When another engine changes the
 * schedule first, nothing this call decided has landed: it reads the schedule again and decides
 * again, so it never writes over a run, a queued occurrence or a count another engine recorded.
 */
export async function triggerSchedule(
  internals: EngineInternals,
  scheduleId: string,
  callbacks: ScheduleCallbacks,
): Promise<ScheduleTriggerResult> {
  const normalizedScheduleId = coerceScheduleId(scheduleId, 'scheduleId');
  return runIsolatedScheduleStateOperation(internals, normalizedScheduleId, async () => {
    let attempted = false;
    for (;;) {
      const loaded = await requireScheduleState(internals, normalizedScheduleId);
      if (loaded.state.status === 'cancelled') {
        throw new Error(`Schedule "${normalizedScheduleId}" has been cancelled and cannot be run`);
      }
      if (!attempted) {
        attempted = true;
        internals.engine.dispatchEvent(
          new ScheduleAttemptedEvent(normalizedScheduleId, internals.options.getNow()),
        );
      }
      const result = await attemptTrigger(internals, loaded, callbacks);
      if (result !== null) return result;
    }
  });
}

/** The schedule a decision goes on from, and the bytes the schedule key holds for it. */
type TriggerBasis = { readonly state: ScheduleState; readonly bytes: Uint8Array };

/**
 * One decision of {@link triggerSchedule} from the schedule as `loaded` holds it, made the way an
 * occurrence's is (`applyScheduleOccurrence`): a run queued ahead starts first, then the overlap
 * policy decides about this one. Resolves `null` when the schedule changed before the decision
 * landed, and nothing of it did.
 */
async function attemptTrigger(
  internals: EngineInternals,
  loaded: LoadedScheduleState,
  callbacks: ScheduleCallbacks,
): Promise<ScheduleTriggerResult | null> {
  const { state } = await callbacks.refreshScheduledWorkflowState(loaded.state);
  const basis = await startQueuedRunAhead(internals, callbacks, { state, bytes: loaded.bytes });
  if (basis === null) return null;
  const blocked = basis.state.overlap !== 'allow' && basis.state.currentWorkflowId !== undefined;
  if (blocked && basis.state.overlap !== 'cancel-running') {
    return recordBlockedRun(internals, basis);
  }
  return startOwnRun(internals, callbacks, basis);
}

/**
 * Starts the run queued first behind a slot that is free, as an occurrence does before its own
 * policy applies. Resolves what to go on from, or `null` when the schedule changed first.
 */
async function startQueuedRunAhead(
  internals: EngineInternals,
  callbacks: ScheduleCallbacks,
  basis: TriggerBasis,
): Promise<TriggerBasis | null> {
  const { state } = basis;
  const [ahead, ...behind] = state.currentWorkflowId === undefined ? state.queuedRuns : [];
  if (ahead === undefined) return basis;
  const after: ScheduleState = {
    ...state,
    currentWorkflowId: ahead.workflowId,
    queuedRuns: behind,
  };
  const bytes = await startRecorded(internals, callbacks, state, after, basis.bytes, {
    workflowId: ahead.workflowId,
    ...(ahead.occurrence !== undefined && { occurrence: ahead.occurrence }),
    ...(ahead.manual === true && { manual: ahead.manual }),
    skipAdmissionIdCheck: true,
  });
  return bytes === null ? null : { state: after, bytes };
}

/**
 * Starts this call's own run: alongside any other under `allow`, in the free slot, or in place of
 * the current run under `cancel-running`.
 */
async function startOwnRun(
  internals: EngineInternals,
  callbacks: ScheduleCallbacks,
  basis: TriggerBasis,
): Promise<ScheduleTriggerResult | null> {
  let { state } = basis;
  const current = state.currentWorkflowId;
  if (state.overlap === 'cancel-running' && current !== undefined) {
    void callbacks.getWorkflowResult(current).catch(() => {});
    await callbacks.cancelWorkflow(current);
    state = clearScheduleCurrentWorkflow(state);
  }
  const workflowId = crypto.randomUUID();
  const after = state.overlap === 'allow' ? state : { ...state, currentWorkflowId: workflowId };
  const started = await startRecorded(internals, callbacks, state, after, basis.bytes, {
    workflowId,
    manual: true,
  });
  return started === null ? null : { outcome: 'started', workflowId };
}

/** Queues this call's run behind the current one, or counts it skipped, as the policy says. */
async function recordBlockedRun(
  internals: EngineInternals,
  { state, bytes }: TriggerBasis,
): Promise<ScheduleTriggerResult | null> {
  const now = internals.options.getNow();
  if (state.overlap === 'queue') {
    const workflowId = crypto.randomUUID();
    const after: ScheduleState = {
      ...state,
      queuedRuns: [...state.queuedRuns, { workflowId, queuedAt: now, manual: true }],
    };
    return (await writeRecorded(internals, after, bytes))
      ? { outcome: 'queued', workflowId }
      : null;
  }
  const after: ScheduleState = {
    ...state,
    skippedCount: state.skippedCount + 1,
    lastSkippedAt: now,
  };
  if (!(await writeRecorded(internals, after, bytes))) return null;
  internals.engine.dispatchEvent(
    new ScheduleSkippedEvent(state.id, now, state.overlap, undefined, state.currentWorkflowId),
  );
  return {
    outcome: 'skipped',
    ...(state.currentWorkflowId !== undefined && { blockingWorkflowId: state.currentWorkflowId }),
  };
}

/**
 * Starts a run with `after`, the schedule that names it, in one batch that commits only while the
 * schedule key still holds `basis` ({@link startUnderScheduleRead}). Resolves the bytes it wrote, or
 * `null` when another engine changed the schedule first.
 */
async function startRecorded(
  internals: EngineInternals,
  callbacks: ScheduleCallbacks,
  state: ScheduleState,
  after: ScheduleState,
  basis: Uint8Array,
  options: ScheduledRunStartOptions,
): Promise<Uint8Array | null> {
  const started = await startUnderScheduleRead(internals, callbacks, state, basis, {
    ...options,
    scheduleStateAfterStart: after,
  });
  return started ? encode(after) : null;
}

/** Writes `after` only while the schedule key still holds `basis`; `false` when it did not. */
async function writeRecorded(
  internals: EngineInternals,
  after: ScheduleState,
  basis: Uint8Array,
): Promise<boolean> {
  try {
    await writeScheduleState(internals, after, {
      includeTimer: false,
      extraConditions: scheduleReadConditions(internals, after.id, { bytes: basis }),
    });
    return true;
  } catch (error) {
    if (error instanceof ScheduleReadConditionLostError) return false;
    throw error;
  }
}
