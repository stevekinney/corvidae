/**
 * An offset clock (COR-2009): the process's own runtime services with a wall clock that reads a
 * chosen instant and then runs forward in real time. Its timers stay real, so everything that waits
 * on one still waits as long as it would.
 *
 * The showcase runs its sample world on one through `HostOptions.runtime`: the seed moves it from
 * one moment of the story to the next, so every record the host, its Bureau and its engine write is
 * stamped at the time the sample world gives it, and the showcase host always boots at the same
 * instant (9:00 AM on Nov 2, 2026, Central time) whatever the date.
 *
 * @module offset-runtime
 */

import { createDefaultRuntimeServices, type RuntimeServices } from '@lostgradient/operative';

/** Runtime services on a wall clock that the caller sets and moves forward. */
export interface OffsetRuntime extends RuntimeServices {
  /** Sets the clock to read `instant` (milliseconds since the epoch) now, then run on from it. */
  readonly setTime: (instant: number) => void;
  /** Moves the clock forward by `milliseconds`. */
  readonly advance: (milliseconds: number) => void;
}

/**
 * Runtime services whose wall clock reads `startAt` now and runs forward in real time; the process's
 * own monotonic clock, timers, identifiers, randomness and deferred tracking otherwise.
 */
export function createOffsetRuntime(startAt: number): OffsetRuntime {
  const real = createDefaultRuntimeServices();
  let offset = startAt - Date.now();
  const now = (): number => Date.now() + offset;
  return {
    ...real,
    clock: { now, nowISO: () => new Date(now()).toISOString() },
    setTime: (instant) => {
      offset = instant - Date.now();
    },
    advance: (milliseconds) => {
      if (!Number.isFinite(milliseconds) || milliseconds < 0) {
        throw new RangeError(`An offset clock only moves forward, not by ${String(milliseconds)}.`);
      }
      offset += milliseconds;
    },
  };
}
