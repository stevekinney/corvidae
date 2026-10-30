/**
 * The two things a person does to a schedule's cadence without changing its definition (COR-1829):
 * skip the next run, and start one now.
 */

import { storageValuesEqual } from '@lostgradient/storage';
import { encode } from '../codec.ts';
import type { ScheduleState, ScheduleTransitionOptions, ScheduleTriggerResult } from '../types.ts';
import type { EngineInternals } from './internals.ts';
import { applyScheduleOccurrence } from './schedule-current-run.ts';
import { findFiringScheduleOccurrence, getNextScheduleOccurrence } from './schedule-occurrence.ts';
import type { ScheduledRunStartOptions } from './schedule-run.ts';
import {
  runIsolatedScheduleStateOperation,
  runScheduleTransition,
} from './schedule-state-operations.ts';
import {
  type LoadedScheduleState,
  loadScheduleState,
  requireScheduleState,
  ScheduleReadConditionLostError,
  scheduleReadConditions,
} from './schedule-state-read.ts';
import type { ScheduleCallbacks } from './schedules.ts';
import { writeScheduleState } from './storage-io.ts';
import { coerceExpectedScheduleRevision, coerceScheduleId } from './validation/schedule.ts';

/** `state` without the skip a person asked for, which a change of cadence or status ends. */
export function withoutSkip(state: ScheduleState): ScheduleState {
  const { skipUntil: _ended, ...rest } = state;
  return rest;
}

/**
 * Skips the next occurrence that would start a run (COR-1829). It counts as a change to the
 * schedule, as a pause does (`revision` goes up by one), and re-reads the schedule's next
 * occurrence from now, so a tick in flight is refused instead of writing over it. Skipping again
 * before that occurrence has passed changes nothing.
 */
export async function skipNextScheduleOccurrence(
  internals: EngineInternals,
  scheduleId: string,
  options?: Pick<ScheduleTransitionOptions, 'expectedRevision'>,
): Promise<void> {
  const normalizedScheduleId = coerceScheduleId(scheduleId, 'scheduleId');
  const expectedRevision = coerceExpectedScheduleRevision(options?.expectedRevision);
  await runScheduleTransition(
    internals,
    normalizedScheduleId,
    expectedRevision,
    async (state, readConditions) => {
      if (state.status !== 'active') {
        throw new Error(
          `Schedule "${normalizedScheduleId}" is ${state.status} and has no next occurrence to skip`,
        );
      }
      const now = internals.options.getNow();
      const nextFireAt = getNextScheduleOccurrence(state, now);
      const skipUntil = findFiringScheduleOccurrence(state, nextFireAt);
      if (state.skipUntil !== undefined && state.skipUntil >= skipUntil) return;
      await writeScheduleState(
        internals,
        {
          ...state,
          skipUntil,
          revision: state.revision + 1,
          updatedAt: now,
          nextFireAt,
        },
        { includeTimer: true, replaceTimerFrom: state, extraConditions: readConditions },
      );
    },
  );
}

/** The fields a trigger changes on a schedule, which are the ones its write carries onto a newer read. */
const TRIGGER_FIELDS = [
  'currentWorkflowId',
  'queuedRuns',
  'skippedCount',
  'lastSkippedAt',
] as const;

/**
 * `fresh`, which another process wrote after this trigger read the schedule, with what the trigger
 * changed (`before` to `after`) laid on it.
 */
function carryTrigger(
  fresh: ScheduleState,
  before: ScheduleState,
  after: ScheduleState,
): ScheduleState {
  let carried: ScheduleState = fresh;
  for (const field of TRIGGER_FIELDS) {
    if (JSON.stringify(before[field]) === JSON.stringify(after[field])) continue;
    const { [field]: _replaced, ...rest } = carried;
    carried = (
      after[field] === undefined ? rest : { ...rest, [field]: after[field] }
    ) as ScheduleState;
  }
  return carried;
}

/** Writes what a trigger did to the schedule, carrying it onto a newer read if the schedule moved. */
async function persistTrigger(
  internals: EngineInternals,
  loaded: LoadedScheduleState,
  after: ScheduleState,
): Promise<void> {
  const before = loaded.state;
  let read = loaded;
  let next = after;
  for (;;) {
    if (storageValuesEqual(encode(next), read.bytes)) return;
    try {
      await writeScheduleState(internals, next, {
        includeTimer: false,
        extraConditions: scheduleReadConditions(internals, next.id, read),
      });
      return;
    } catch (error) {
      if (!(error instanceof ScheduleReadConditionLostError)) throw error;
    }
    const fresh = await loadScheduleState(internals, next.id);
    if (fresh === null) return;
    read = fresh;
    next = carryTrigger(fresh.state, before, after);
  }
}

/**
 * Starts one run of the schedule now (COR-1829), under its overlap policy, and tells what the
 * policy did with it. The run is not an occurrence of the cadence: `nextFireAt`, `lastFireAt` and
 * `revision` stay as they are, and the run's schedule metadata carries `manual: true`. A paused
 * schedule can be run; a cancelled one cannot.
 */
export async function triggerSchedule(
  internals: EngineInternals,
  scheduleId: string,
  callbacks: ScheduleCallbacks,
): Promise<ScheduleTriggerResult> {
  const normalizedScheduleId = coerceScheduleId(scheduleId, 'scheduleId');
  return runIsolatedScheduleStateOperation(internals, normalizedScheduleId, async () => {
    const loaded = await requireScheduleState(internals, normalizedScheduleId);
    const { state } = loaded;
    if (state.status === 'cancelled') {
      throw new Error(`Schedule "${normalizedScheduleId}" has been cancelled and cannot be run`);
    }
    let startedWorkflowId: string | undefined;
    const observed: ScheduleCallbacks = {
      ...callbacks,
      startScheduledRun: async (startState, startOptions?: ScheduledRunStartOptions) => {
        const workflowId = await callbacks.startScheduledRun(startState, startOptions);
        if (startOptions?.manual === true) startedWorkflowId = workflowId;
        return workflowId;
      },
    };
    const after = await applyScheduleOccurrence(internals, state, observed, undefined, true);
    await persistTrigger(internals, loaded, after);

    if (startedWorkflowId !== undefined) {
      return { outcome: 'started', workflowId: startedWorkflowId };
    }
    const queued = after.queuedRuns.find(
      (run) =>
        run.manual === true &&
        !state.queuedRuns.some((before) => before.workflowId === run.workflowId),
    );
    if (queued !== undefined) return { outcome: 'queued', workflowId: queued.workflowId };
    return {
      outcome: 'skipped',
      ...(after.currentWorkflowId !== undefined && { blockingWorkflowId: after.currentWorkflowId }),
    };
  });
}
