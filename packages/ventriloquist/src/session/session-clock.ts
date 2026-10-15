/** Cancels a scheduled callback. Calling it after the callback ran, or twice, does nothing. */
export type CancelTimer = () => void;

/**
 * The only source of time the session core uses. Every deadline (input acknowledgement, liveness,
 * drain and cleanup) is a one-shot relative timer, so a host or a test supplies this one method
 * and nothing in the core reads a wall clock. The neutral program has no timer globals, which is
 * why the clock is injected rather than assumed.
 */
export interface SessionClock {
  schedule(callback: () => void, delayMilliseconds: number): CancelTimer;
}

type TimerGlobals = {
  setTimeout(callback: () => void, delayMilliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
};

/** A clock backed by the host's timers, for production use. Tests inject a manual clock instead. */
export const systemClock: SessionClock = {
  schedule(callback, delayMilliseconds) {
    const timers = globalThis as unknown as TimerGlobals;
    const handle = timers.setTimeout(callback, delayMilliseconds);
    return () => timers.clearTimeout(handle);
  },
};
