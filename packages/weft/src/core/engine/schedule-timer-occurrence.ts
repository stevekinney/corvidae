/**
 * Recording the occurrences of one schedule timer tick (COR-1925): what a tick plans, the schedule
 * it leaves behind, and how each occurrence's run is committed with the schedule that names it.
 */

import type { ScheduleState } from '../types.ts';
import type { EngineInternals } from './internals.ts';
import {
  dispatchMissedFires,
  type MissedScheduleOccurrences,
  type RecordedMisses,
} from './schedule-missed-fires.ts';
import type { OccurrenceCommit } from './schedule-occurrence-commit.ts';
import { getNextScheduleOccurrence, isSkippedOccurrence } from './schedule-occurrence.ts';
import { loadScheduleState, ScheduleReadConditionLostError } from './schedule-state-read.ts';
import {
  carryConcurrentRecords,
  isStillAsTickLeftIt,
  persistScheduleTimerState,
  type ScheduleTimerProgress,
} from './schedule-timer-writes.ts';
import type { ScheduleCallbacks } from './schedules.ts';

export type PlannedScheduleTimerWork = {
  /** What this tick missed, one entry per reason; empty when it missed nothing. */
  missed: MissedScheduleOccurrences[];
  /** The occurrences that start a run. */
  occurrencesToProcess: number[];
  /**
   * The last instant this tick accounted for, fired or missed. The schedule's next occurrence is
   * the one after it, so what was accounted for is never offered again.
   */
  anchor: number;
};

/**
 * A tick's plan with what recording its misses changes (COR-1829): the counters and row writes
 * that go in the first write the tick makes, and what to announce when that write has landed.
 */
export type ScheduleTimerWork = PlannedScheduleTimerWork & { recorded: RecordedMisses };

/**
 * The schedule once the tick's work is done: its next occurrence is the one after the last instant
 * the tick accounted for, and a skip the tick has moved past is spent.
 */
export function scheduleAfterWork(state: ScheduleState, work: ScheduleTimerWork): ScheduleState {
  const nextFireAt = resolveNextScheduleFireAt(state, work);
  if (state.skipUntil === undefined || state.skipUntil > work.anchor) {
    return { ...state, nextFireAt };
  }
  const { skipUntil: _spent, ...withoutSkip } = state;
  return { ...withoutSkip, nextFireAt };
}

function resolveNextScheduleFireAt(state: ScheduleState, work: ScheduleTimerWork): number {
  const next = getNextScheduleOccurrence(state, work.anchor);
  if (next <= work.anchor) {
    throw new Error(`Schedule "${state.id}" produced a non-advancing occurrence`);
  }
  return next;
}

/**
 * Writes the state after one occurrence, with what the tick missed when no earlier write carried it
 * (announced once it has landed). Resolves what was written, which carries what another engine
 * recorded meanwhile, or `null` when the schedule is no longer the tick's to write.
 */
async function writeOccurrenceState(
  internals: EngineInternals,
  progress: ScheduleTimerProgress,
  state: ScheduleState,
  work: ScheduleTimerWork,
  includeTimer: boolean,
  withMisses: boolean,
): Promise<ScheduleState | null> {
  const persisted = await persistScheduleTimerState(internals, progress, state, {
    includeTimer,
    ...(withMisses && { additionalOperations: work.recorded.operations }),
  });
  if (!persisted) return null;
  if (withMisses) dispatchMissedFires(internals, state.id, work.recorded.announce);
  return progress.stored.state;
}

/**
 * Decides and records one occurrence (COR-1925). A run it starts commits in the same batch as the
 * schedule that names it, the next timer and what the tick missed, conditioned on the bytes the
 * schedule key last held for the tick (the way a run now commits). When another engine changed the
 * schedule first, that batch did not commit and no run launched: the schedule is read again, and if
 * it is still as the tick left it, the occurrence is decided again with what the other engine
 * recorded carried in; otherwise whatever changed it owns the schedule. An occurrence that starts
 * no run (a skip, a queued run, one a person skipped) is written by {@link writeOccurrenceState}.
 *
 * Resolves what was written, or `null` when the schedule is no longer the tick's to write.
 */
export async function recordOccurrence(
  internals: EngineInternals,
  progress: ScheduleTimerProgress,
  input: {
    state: ScheduleState;
    occurrence: number;
    finalOccurrence: boolean;
    withMisses: boolean;
    work: ScheduleTimerWork;
    now: number;
  },
  callbacks: ScheduleCallbacks,
): Promise<ScheduleState | null> {
  const { occurrence, finalOccurrence, withMisses, work, now } = input;
  let before = input.state;
  let retry = false;
  for (;;) {
    // A skip another engine recorded and this decision carried in is honored the second time.
    const skipped = isSkippedOccurrence(before, occurrence);
    const stamp = (applied: ScheduleState): ScheduleState => {
      const stamped = skipped
        ? { ...applied, updatedAt: now }
        : { ...applied, lastFireAt: occurrence, updatedAt: now };
      return finalOccurrence ? scheduleAfterWork(stamped, work) : stamped;
    };
    const base = progress.stored.state;
    const commit: OccurrenceCommit = {
      internals,
      progress,
      retry,
      concluded: null,
      conclude: (after) => ({
        state: stamp(after),
        includeTimer: finalOccurrence,
        additionalOperations: withMisses ? work.recorded.operations : [],
      }),
    };
    let applied = before;
    if (!skipped) {
      try {
        applied = await callbacks.applyScheduleOccurrence(before, occurrence, undefined, commit);
      } catch (error) {
        if (!(error instanceof ScheduleReadConditionLostError)) throw error;
        const current = await loadScheduleState(internals, before.id);
        if (current === null || !isStillAsTickLeftIt(current.state, base)) return null;
        before = carryConcurrentRecords(before, base, current.state);
        progress.stored = current;
        retry = true;
        continue;
      }
    }
    if (commit.concluded !== null) {
      progress.state = commit.concluded;
      if (withMisses) dispatchMissedFires(internals, before.id, work.recorded.announce);
      return commit.concluded;
    }
    const nextState = stamp(applied);
    progress.state = nextState;
    return writeOccurrenceState(internals, progress, nextState, work, finalOccurrence, withMisses);
  }
}
