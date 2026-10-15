import type { CancelTimer, SessionClock } from '../session-clock.ts';

type ScheduledTimer = { readonly dueAt: number; readonly callback: () => void };

/**
 * A deterministic `SessionClock`. Time moves only when `advance` is called, and timers due at the
 * same instant run in the order they were scheduled, so a test controls every deadline exactly.
 */
export class ManualClock implements SessionClock {
  #now: number;
  #nextId: number;
  readonly #timers: Map<number, ScheduledTimer>;

  constructor() {
    this.#now = 0;
    this.#nextId = 1;
    this.#timers = new Map();
  }

  get now(): number {
    return this.#now;
  }

  /** How many scheduled timers have neither fired nor been canceled. */
  get pendingTimers(): number {
    return this.#timers.size;
  }

  schedule(callback: () => void, delayMilliseconds: number): CancelTimer {
    const id = this.#nextId++;
    this.#timers.set(id, { dueAt: this.#now + delayMilliseconds, callback });
    return () => {
      this.#timers.delete(id);
    };
  }

  /** Move time forward, running every timer that comes due, including ones scheduled meanwhile. */
  advance(milliseconds: number): void {
    const target = this.#now + milliseconds;
    for (;;) {
      let nextId: number | undefined;
      let next: ScheduledTimer | undefined;
      for (const [id, timer] of this.#timers) {
        if (timer.dueAt <= target && (next === undefined || timer.dueAt < next.dueAt)) {
          nextId = id;
          next = timer;
        }
      }
      if (nextId === undefined || next === undefined) break;
      this.#timers.delete(nextId);
      this.#now = next.dueAt;
      next.callback();
    }
    this.#now = target;
  }
}
