/**
 * The writes a schedule timer tick makes to the schedule it fires (COR-1594). A tick decides what
 * to write from the schedule it read, possibly some time and a whole run later, so every write is
 * conditioned on the bytes the schedule key last held for the tick, and a write that loses that
 * condition is made again only if the schedule is still as the tick left it.
 */

import type { BatchOperation } from '@lostgradient/storage';
import type { ScheduleState } from '../types.ts';
import type { EngineInternals } from './internals.ts';
import { getNextScheduleOccurrence } from './schedule-occurrence.ts';
import {
  type LoadedScheduleState,
  loadScheduleState,
  ScheduleReadConditionLostError,
  scheduleReadConditions,
} from './schedule-state-read.ts';
import { writeScheduleState } from './storage-io.ts';

export class ScheduleStatePersistenceError extends Error {
  constructor(
    readonly scheduleId: string,
    cause: unknown,
  ) {
    super(`Failed to persist schedule "${scheduleId}" while processing its timer`, { cause });
  }
}

/**
 * The latest state a section has, for the pause it owes a schedule whose processing failed, and
 * the state and bytes the schedule key last held for this tick (read, or written by it), which
 * its next write is conditioned on (COR-1594). They differ while a section has computed a state
 * it has not yet written.
 */
export type ScheduleTimerProgress = { state: ScheduleState; stored: LoadedScheduleState };

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
export async function persistScheduleTimerState(
  internals: EngineInternals,
  progress: ScheduleTimerProgress,
  state: ScheduleState,
  options?: { includeTimer?: boolean; additionalOperations?: BatchOperation[] },
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
export async function pauseScheduleAfterTimerFailure(
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
