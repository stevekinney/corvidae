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
 * The clock can also be held at an instant ({@link OffsetRuntime.hold}): it then reads that instant,
 * however much real time passes, until it is let go. The seed holds it at the moment a schedule
 * comes due, because the engine counts an occurrence its scheduler reaches more than a poll and a
 * second late as missed, and starts no run for it (COR-2632).
 *
 * @module offset-runtime
 */

import { createDefaultRuntimeServices, type RuntimeServices } from '@lostgradient/operative';

/** Runtime services on a wall clock that the caller sets and moves forward. */
export interface OffsetRuntime extends RuntimeServices {
  /**
   * Sets the clock to read `instant` (milliseconds since the epoch) now, then run on from it. A held
   * clock is set and stays held.
   */
  readonly setTime: (instant: number) => void;
  /** Moves the clock forward by `milliseconds`, held or not. */
  readonly advance: (milliseconds: number) => void;
  /**
   * Sets the clock to read `instant` and keeps it there while real time passes, until {@link
   * OffsetRuntime.resume}. {@link OffsetRuntime.setTime} and {@link OffsetRuntime.advance} still
   * move it.
   */
  readonly hold: (instant: number) => void;
  /** Lets a held clock run forward in real time again, from the instant it reads; a running one is left as it is. */
  readonly resume: () => void;
}

/** What an offset clock runs forward on. */
interface OffsetRuntimeOptions {
  /**
   * The real clock, in milliseconds since the epoch: `Date.now` unless a test supplies one it moves
   * itself, to stand for real time passing without waiting for it.
   */
  readonly realNow?: () => number;
}

/**
 * Runtime services whose wall clock reads `startAt` now and runs forward in real time; the process's
 * own monotonic clock, timers, identifiers, randomness and deferred tracking otherwise.
 */
export function createOffsetRuntime(
  startAt: number,
  options: OffsetRuntimeOptions = {},
): OffsetRuntime {
  const real = createDefaultRuntimeServices();
  const realNow = options.realNow ?? Date.now;
  let offset = startAt - realNow();
  /** The instant a held clock reads, or `undefined` while it runs. */
  let held: number | undefined;
  const now = (): number => held ?? realNow() + offset;
  const setTime = (instant: number): void => {
    if (held === undefined) offset = instant - realNow();
    else held = instant;
  };
  return {
    ...real,
    clock: { now, nowISO: () => new Date(now()).toISOString() },
    setTime,
    advance: (milliseconds) => {
      if (!Number.isFinite(milliseconds) || milliseconds < 0) {
        throw new RangeError(`An offset clock only moves forward, not by ${String(milliseconds)}.`);
      }
      if (held === undefined) offset += milliseconds;
      else held += milliseconds;
    },
    hold: (instant) => {
      held = instant;
    },
    resume: () => {
      if (held === undefined) return;
      offset = held - realNow();
      held = undefined;
    },
  };
}
