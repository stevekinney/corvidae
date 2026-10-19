import { ScheduleMissedFireEvent } from '../events/schedule-events.ts';
import type { ScheduleState, TimerEntry } from '../types.ts';
import type { EngineInternals } from './internals.ts';
import { awaitScheduledRunTurn } from './schedule-current-run.ts';
import { resolveEffectiveScheduleFireAt } from './schedule-jitter.ts';
import { collectDueScheduleOccurrences, getNextScheduleOccurrence } from './schedule-occurrence.ts';
import { drainQueuedScheduleRun } from './schedule-overlap.ts';
import type { ScheduleCallbacks } from './schedules.ts';
import {
  loadScheduleState,
  runSerializedScheduleStateOperation,
  writeScheduleState,
} from './storage-io.ts';

const SCHEDULE_LATE_GRACE_MILLISECONDS = 1000;
const MAX_SCHEDULE_BACKFILL_OCCURRENCES_PER_TICK = 256;
const MAX_MISSED_FIRE_COUNT_PER_TICK = MAX_SCHEDULE_BACKFILL_OCCURRENCES_PER_TICK;

type ActiveScheduleTimerState = ScheduleState & { nextFireAt: number };

type MissedScheduleOccurrences = {
  count: number;
  lastMissedFireAt: number;
  windowStart: number;
  windowEnd: number;
};

type ScheduleTimerWork = {
  dueOccurrences: number[];
  missedOccurrences?: MissedScheduleOccurrences;
  occurrencesToProcess: number[];
  skipMissedOccurrences: boolean;
};

class ScheduleStatePersistenceError extends Error {
  constructor(
    readonly scheduleId: string,
    cause: unknown,
  ) {
    super(`Failed to persist schedule "${scheduleId}" while processing its timer`, { cause });
  }
}

/**
 * One schedule timer tick, in serialized sections of the schedule's own write.
 *
 * A backfilled run is waited for before the next occurrence starts, and the run's activity can
 * call back into its schedule (`pauseSchedule`, `resumeSchedule`, `cancelSchedule`,
 * `updateSchedule`), all of which take that serialization. So the wait is made outside it: an
 * occurrence is started and its state written inside one section, the run's turn is awaited with
 * the serialization released, and the next section reads the schedule again before it goes on.
 * A schedule that changed while the run was going (its `revision` moved, or it is no longer
 * active) is not written back from the copy this tick loaded: whatever changed it owns the
 * timer from then on, and the occurrences this tick had left are not started.
 */
export async function handleScheduleTimer(
  internals: EngineInternals,
  entry: TimerEntry,
  callbacks: ScheduleCallbacks,
): Promise<void> {
  let step = await runSerializedScheduleStateOperation(internals, entry.workflowId, () =>
    beginScheduleTimer(internals, entry, callbacks),
  );
  while (step.kind === 'settle') {
    const pending = step;
    await awaitScheduledRunTurn(internals, pending.workflowId, callbacks);
    step = await runSerializedScheduleStateOperation(internals, entry.workflowId, () =>
      resumeScheduleTimer(internals, entry.workflowId, pending, callbacks),
    );
  }
}

/** Where a tick stands between its serialized sections. */
type ScheduleTimerStep =
  | { readonly kind: 'done' }
  | {
      readonly kind: 'settle';
      /** The backfilled run to wait for, with the serialization released. */
      readonly workflowId: string;
      readonly work: ScheduleTimerWork;
      readonly now: number;
      /** The occurrence just started: the next section goes on from the one after it. */
      readonly index: number;
      /** The schedule's `revision` as this tick left it, to tell whether anything else changed it. */
      readonly revision: number;
    };

/** The latest state a section has, for the pause it owes a schedule whose processing failed. */
type ScheduleTimerProgress = { state: ScheduleState };

/** Runs one section, pausing the schedule when its processing fails, as the whole tick used to. */
async function guardScheduleTimerSection(
  internals: EngineInternals,
  progress: ScheduleTimerProgress,
  section: () => Promise<ScheduleTimerStep>,
): Promise<ScheduleTimerStep> {
  try {
    return await section();
  } catch (error) {
    if (error instanceof ScheduleStatePersistenceError) {
      throw error;
    }
    await pauseScheduleAfterTimerFailure(internals, progress.state, error);
    return { kind: 'done' };
  }
}

async function beginScheduleTimer(
  internals: EngineInternals,
  entry: TimerEntry,
  callbacks: ScheduleCallbacks,
): Promise<ScheduleTimerStep> {
  if (internals.deposed) return { kind: 'done' };

  const state = await loadScheduleState(internals, entry.workflowId);
  if (!isCurrentActiveScheduleTimer(state, entry)) {
    return { kind: 'done' };
  }

  const progress: ScheduleTimerProgress = { state };
  return guardScheduleTimerSection(internals, progress, async () => {
    const now = internals.options.getNow();
    const work = planScheduleTimerWork(state, entry, now);
    if (!work) {
      return { kind: 'done' };
    }

    if (work.occurrencesToProcess.length === 0) {
      const nextState: ScheduleState = {
        ...state,
        updatedAt: now,
        nextFireAt: resolveNextScheduleFireAt(state, work, now),
        ...(work.missedOccurrences && {
          lastMissedFireAt: work.missedOccurrences.lastMissedFireAt,
          missedFireCount: state.missedFireCount + work.missedOccurrences.count,
        }),
      };
      progress.state = nextState;
      await persistScheduleTimerState(internals, nextState);
      if (work.missedOccurrences) {
        internals.engine.dispatchEvent(
          new ScheduleMissedFireEvent(
            nextState.id,
            work.missedOccurrences.count,
            work.missedOccurrences.windowStart,
            work.missedOccurrences.windowEnd,
          ),
        );
      }
      return { kind: 'done' };
    }

    return processScheduleTimerOccurrences(internals, state, work, now, callbacks, 0, progress);
  });
}

/**
 * The section that follows a backfilled run's turn: reads the schedule again, and goes on only if
 * nothing else changed it meanwhile.
 */
async function resumeScheduleTimer(
  internals: EngineInternals,
  scheduleId: string,
  pending: Extract<ScheduleTimerStep, { kind: 'settle' }>,
  callbacks: ScheduleCallbacks,
): Promise<ScheduleTimerStep> {
  if (internals.deposed) return { kind: 'done' };

  const current = await loadScheduleState(internals, scheduleId);
  if (current === null || current.status !== 'active' || current.revision !== pending.revision) {
    return { kind: 'done' };
  }

  const progress: ScheduleTimerProgress = { state: current };
  return guardScheduleTimerSection(internals, progress, async () => {
    const { work, now, index } = pending;
    const refreshed = await callbacks.refreshScheduledWorkflowState(current);
    let nextState = refreshed.state;
    // The run this tick waited for is over and this section just cleared the slot, so its own
    // terminal handler, which comes after this section, finds the slot no longer names it and
    // drains nothing. A run queued behind it starts here instead, as it does when an occurrence
    // finds the slot free, or it waits a whole cadence.
    if (
      current.currentWorkflowId !== undefined &&
      nextState.currentWorkflowId === undefined &&
      nextState.queuedRuns.length > 0
    ) {
      nextState = await drainQueuedScheduleRun(nextState, callbacks);
    }
    if (index === work.occurrencesToProcess.length - 1) {
      nextState = {
        ...nextState,
        updatedAt: now,
        nextFireAt: resolveNextScheduleFireAt(nextState, work, now),
      };
      progress.state = nextState;
      await persistScheduleTimerState(internals, nextState);
    }
    progress.state = nextState;
    return processScheduleTimerOccurrences(
      internals,
      nextState,
      work,
      now,
      callbacks,
      index + 1,
      progress,
    );
  });
}

function isCurrentActiveScheduleTimer(
  state: ScheduleState | null,
  entry: TimerEntry,
): state is ActiveScheduleTimerState {
  return (
    state?.status === 'active' &&
    state.nextFireAt !== null &&
    resolveEffectiveScheduleFireAt(state, state.nextFireAt) === entry.fireAt
  );
}

function planScheduleTimerWork(
  state: ActiveScheduleTimerState,
  entry: TimerEntry,
  now: number,
): ScheduleTimerWork | null {
  const dueOccurrences = collectDueScheduleOccurrences(
    state,
    state.nextFireAt,
    Math.max(now, entry.fireAt),
    state.backfill ? MAX_SCHEDULE_BACKFILL_OCCURRENCES_PER_TICK : 2,
  );
  if (dueOccurrences.length === 0) return null;

  if (!state.backfill && now - entry.fireAt > SCHEDULE_LATE_GRACE_MILLISECONDS) {
    return {
      dueOccurrences,
      missedOccurrences: countMissedScheduleOccurrences(state, state.nextFireAt, now),
      occurrencesToProcess: [],
      skipMissedOccurrences: true,
    };
  }

  const occurrencesToProcess = state.backfill ? dueOccurrences : dueOccurrences.slice(0, 1);
  return {
    dueOccurrences,
    occurrencesToProcess,
    skipMissedOccurrences: false,
  };
}

function countMissedScheduleOccurrences(
  state: ActiveScheduleTimerState,
  firstDueAt: number,
  throughTimestamp: number,
): MissedScheduleOccurrences {
  let count = 0;
  let occurrence = firstDueAt;
  let lastMissedFireAt = firstDueAt;

  while (occurrence <= throughTimestamp && count < MAX_MISSED_FIRE_COUNT_PER_TICK) {
    count += 1;
    lastMissedFireAt = occurrence;
    const nextOccurrence = getNextScheduleOccurrence(state, occurrence);
    if (nextOccurrence <= occurrence) {
      throw new Error(`Schedule "${state.id}" produced a non-advancing occurrence`);
    }
    occurrence = nextOccurrence;
  }

  const cappedBeforeThroughTimestamp = occurrence <= throughTimestamp;
  return {
    count,
    lastMissedFireAt,
    windowStart: firstDueAt,
    windowEnd: cappedBeforeThroughTimestamp ? lastMissedFireAt : throughTimestamp,
  };
}

function resolveNextScheduleFireAt(
  state: ScheduleState,
  work: ScheduleTimerWork,
  now: number,
): number {
  if (work.skipMissedOccurrences) {
    return getNextScheduleOccurrence(state, work.missedOccurrences?.lastMissedFireAt ?? now);
  }

  const anchorOccurrence = work.occurrencesToProcess.at(-1) ?? work.dueOccurrences.at(-1)!;
  return getNextScheduleOccurrence(state, anchorOccurrence);
}

/**
 * Starts the occurrences from `fromIndex`, writing the state after each. A backfilled run that
 * is still the schedule's current one ends the section: the caller waits for it with the
 * serialization released and comes back through {@link resumeScheduleTimer}.
 */
async function processScheduleTimerOccurrences(
  internals: EngineInternals,
  state: ScheduleState,
  work: ScheduleTimerWork,
  now: number,
  callbacks: ScheduleCallbacks,
  fromIndex: number,
  progress: ScheduleTimerProgress,
): Promise<ScheduleTimerStep> {
  let nextState: ScheduleState = state;

  for (let index = fromIndex; index < work.occurrencesToProcess.length; index += 1) {
    const occurrence = work.occurrencesToProcess[index]!;
    const finalOccurrence = index === work.occurrencesToProcess.length - 1;
    nextState = {
      ...(await callbacks.applyScheduleOccurrence(nextState, occurrence)),
      lastFireAt: occurrence,
      updatedAt: now,
    };
    if (finalOccurrence) {
      nextState = {
        ...nextState,
        nextFireAt: resolveNextScheduleFireAt(nextState, work, now),
      };
    }
    progress.state = nextState;
    await persistScheduleTimerState(internals, nextState, { includeTimer: finalOccurrence });
    if (state.backfill && nextState.currentWorkflowId !== undefined) {
      return {
        kind: 'settle',
        workflowId: nextState.currentWorkflowId,
        work,
        now,
        index,
        revision: nextState.revision,
      };
    }
  }

  return { kind: 'done' };
}

async function persistScheduleTimerState(
  internals: EngineInternals,
  state: ScheduleState,
  options?: { includeTimer?: boolean },
): Promise<void> {
  try {
    await writeScheduleState(internals, state, options);
  } catch (error) {
    throw new ScheduleStatePersistenceError(state.id, error);
  }
}

async function pauseScheduleAfterTimerFailure(
  internals: EngineInternals,
  state: ScheduleState,
  error: unknown,
): Promise<void> {
  const errorNow = internals.options.getNow();
  const pausedState: ScheduleState = {
    ...state,
    status: 'paused',
    revision: state.revision + 1,
    updatedAt: errorNow,
    nextFireAt: getNextScheduleOccurrence(state, errorNow),
  };
  await writeScheduleState(internals, pausedState, { includeTimer: false });
  console.error(`[weft] Paused schedule "${pausedState.id}" after timer processing failed:`, error);
}
