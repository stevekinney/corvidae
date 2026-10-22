import { ScheduleMissedFireEvent } from '../events/schedule-events.ts';
import type { ScheduleState, TimerEntry } from '../types.ts';
import { WeftError } from '../weft-error.ts';
import type { EngineInternals } from './internals.ts';
import { awaitScheduledRunTurn } from './schedule-current-run.ts';
import { resolveEffectiveScheduleFireAt } from './schedule-jitter.ts';
import { collectDueScheduleOccurrences, getNextScheduleOccurrence } from './schedule-occurrence.ts';
import { drainQueuedScheduleRun } from './schedule-overlap.ts';
import type { ScheduleCallbacks } from './schedules.ts';
import {
  loadScheduleState,
  type LoadedScheduleState,
  runSerializedScheduleStateOperation,
  ScheduleReadConditionLostError,
  scheduleReadConditions,
  writeScheduleState,
} from './storage-io.ts';

/**
 * How far past one poll interval a tick may land before a non-backfill occurrence it reaches
 * counts as missed. The scheduler only sees an occurrence when a poll tick lands after it, so a
 * healthy engine reaches it up to a whole poll interval late, plus the tick's own drift
 * (COR-1616). Only lateness beyond both, such as an engine that was down, is a missed fire.
 */
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
    try {
      await awaitScheduledRunTurn(internals, pending.workflowId, callbacks);
    } catch (error) {
      await failScheduleTimerWait(internals, entry.workflowId, pending, error);
      return;
    }
    step = await runSerializedScheduleStateOperation(internals, entry.workflowId, () =>
      resumeScheduleTimer(internals, entry.workflowId, pending, callbacks),
    );
  }
}

/**
 * The wait for a backfilled run's turn failed, as it does when the engine's handling of the run
 * fails (a storage fault while the run is saved). The whole tick used to sit inside one failure
 * boundary, and the schedule was paused once; the wait is outside it now, so the boundary is
 * rebuilt here. Left to escape, the failure would make the scheduler retry the entry, and every
 * poll would plan the same occurrence again, whose `nextFireAt` a non-final occurrence leaves
 * unchanged.
 *
 * The pause is made in a serialized section, from the schedule as it is now, and only if it is
 * still active at the `revision` this tick left it: a pause, an update, or a cancel made during
 * the wait owns the schedule, and a pause written on top of it, or from the state this tick last
 * wrote, would undo it. A failure that is the engine shutting down is not a fault of the
 * schedule: pausing it would leave it paused for good after the restart, so it is left as it
 * is for boot recovery.
 */
async function failScheduleTimerWait(
  internals: EngineInternals,
  scheduleId: string,
  pending: Extract<ScheduleTimerStep, { kind: 'settle' }>,
  error: unknown,
): Promise<void> {
  if (isEngineShutdown(internals, error)) return;
  await runSerializedScheduleStateOperation(internals, scheduleId, async () => {
    const current = await loadScheduleState(internals, scheduleId);
    if (
      current === null ||
      current.state.status !== 'active' ||
      current.state.revision !== pending.revision
    ) {
      return;
    }
    await pauseScheduleAfterTimerFailure(internals, current.state, current, error);
  });
}

/** Whether `error` is the engine going away rather than something the schedule's run did. */
function isEngineShutdown(internals: EngineInternals, error: unknown): boolean {
  return internals.disposed || (error instanceof WeftError && error.code === 'EngineDisposedError');
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

/**
 * The latest state a section has, for the pause it owes a schedule whose processing failed, and
 * the state and bytes the schedule key last held for this tick (read, or written by it), which
 * its next write is conditioned on (COR-1594). They differ while a section has computed a state
 * it has not yet written.
 */
type ScheduleTimerProgress = { state: ScheduleState; stored: LoadedScheduleState };

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
    await pauseScheduleAfterTimerFailure(internals, progress.state, progress.stored, error);
    return { kind: 'done' };
  }
}

async function beginScheduleTimer(
  internals: EngineInternals,
  entry: TimerEntry,
  callbacks: ScheduleCallbacks,
): Promise<ScheduleTimerStep> {
  if (internals.deposed) return { kind: 'done' };

  const loaded = await loadScheduleState(internals, entry.workflowId);
  const state = loaded?.state ?? null;
  if (loaded === null || !isCurrentActiveScheduleTimer(state, entry)) {
    return { kind: 'done' };
  }

  const progress: ScheduleTimerProgress = { state, stored: loaded };
  return guardScheduleTimerSection(internals, progress, async () => {
    const now = internals.options.getNow();
    const work = planScheduleTimerWork(
      state,
      entry,
      now,
      internals.options.schedulerPollIntervalMs + SCHEDULE_LATE_GRACE_MILLISECONDS,
    );
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
      if (!(await persistScheduleTimerState(internals, progress, nextState))) {
        return { kind: 'done' };
      }
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

  const loaded = await loadScheduleState(internals, scheduleId);
  if (
    loaded === null ||
    loaded.state.status !== 'active' ||
    loaded.state.revision !== pending.revision
  ) {
    return { kind: 'done' };
  }
  const current = loaded.state;

  const progress: ScheduleTimerProgress = { state: current, stored: loaded };
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
      if (!(await persistScheduleTimerState(internals, progress, nextState))) {
        return { kind: 'done' };
      }
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
  lateGraceMilliseconds: number,
): ScheduleTimerWork | null {
  const dueOccurrences = collectDueScheduleOccurrences(
    state,
    state.nextFireAt,
    Math.max(now, entry.fireAt),
    state.backfill ? MAX_SCHEDULE_BACKFILL_OCCURRENCES_PER_TICK : 2,
  );
  if (dueOccurrences.length === 0) return null;

  if (!state.backfill && now - entry.fireAt > lateGraceMilliseconds) {
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
    if (
      !(await persistScheduleTimerState(internals, progress, nextState, {
        includeTimer: finalOccurrence,
      }))
    ) {
      return { kind: 'done' };
    }
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

/**
 * Whether the schedule is still as this tick left it: active, at the `revision` the tick holds,
 * with the `nextFireAt` it holds. Another process's pause, update or cancel moves the revision,
 * and another process's timer tick moves `nextFireAt`; a clearing of the current run moves neither.
 */
function isStillAsTickLeftIt(current: ScheduleState, left: ScheduleState): boolean {
  return (
    current.status === 'active' &&
    current.revision === left.revision &&
    current.nextFireAt === left.nextFireAt
  );
}

/**
 * Writes the tick's state, conditioned on the bytes the schedule key last held for it (COR-1594).
 * A write that loses the condition read a schedule another process has since changed: the schedule
 * is read again, and the write is made again, on the new bytes, only if the schedule is still as
 * this tick left it ({@link isStillAsTickLeftIt}). Otherwise whatever changed it owns the schedule
 * and the timer from then on, nothing is written, and this resolves `false`.
 */
async function persistScheduleTimerState(
  internals: EngineInternals,
  progress: ScheduleTimerProgress,
  state: ScheduleState,
  options?: { includeTimer?: boolean },
): Promise<boolean> {
  try {
    for (;;) {
      try {
        const bytes = await writeScheduleState(internals, state, {
          ...options,
          extraConditions: scheduleReadConditions(internals, state.id, progress.stored),
        });
        progress.stored = { state, bytes };
        return true;
      } catch (error) {
        if (!(error instanceof ScheduleReadConditionLostError)) throw error;
      }
      const current = await loadScheduleState(internals, state.id);
      if (current === null || !isStillAsTickLeftIt(current.state, progress.stored.state)) {
        return false;
      }
      progress.stored = current;
    }
  } catch (error) {
    throw new ScheduleStatePersistenceError(state.id, error);
  }
}

/**
 * Pauses `state` after its timer processing failed, conditioned on `stored`, the bytes the
 * schedule key last held for the tick. If the condition is lost the schedule is read again: it is
 * paused from what is stored now only if it is still as the tick left it, and otherwise left to
 * whatever changed it (COR-1594).
 */
async function pauseScheduleAfterTimerFailure(
  internals: EngineInternals,
  state: ScheduleState,
  stored: LoadedScheduleState,
  error: unknown,
): Promise<void> {
  let basis = state;
  let read = stored;
  for (;;) {
    const errorNow = internals.options.getNow();
    const pausedState: ScheduleState = {
      ...basis,
      status: 'paused',
      revision: basis.revision + 1,
      updatedAt: errorNow,
      nextFireAt: getNextScheduleOccurrence(basis, errorNow),
    };
    try {
      await writeScheduleState(internals, pausedState, {
        includeTimer: false,
        extraConditions: scheduleReadConditions(internals, state.id, read),
      });
      console.error(
        `[weft] Paused schedule "${pausedState.id}" after timer processing failed:`,
        error,
      );
      return;
    } catch (writeError) {
      if (!(writeError instanceof ScheduleReadConditionLostError)) throw writeError;
    }
    const current = await loadScheduleState(internals, state.id);
    if (current === null || !isStillAsTickLeftIt(current.state, stored.state)) return;
    basis = current.state;
    read = current;
  }
}
