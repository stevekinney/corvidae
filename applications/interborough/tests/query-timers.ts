/**
 * TanStack Query's timers, tracked so the preload can clear them between tests.
 *
 * When a query loses its last observer, TanStack Query schedules its removal after `gcTime`, five
 * minutes by default. That timer holds the query, its data and everything the data references. A
 * UI shard runs for two to four minutes, so in a test run no such timer ever fires: every query
 * every test fetched stayed alive until the process exited, and each shard grew to gigabytes. Four
 * shards on a 16 GB CI runner starved it until GitHub lost the runner and its log ("The hosted
 * runner lost communication with the server").
 *
 * TanStack Query lets the application supply the functions its timers use
 * (`timeoutManager.setTimeoutProvider`). This one records every timer it starts, and the preload
 * clears what is left after each test, once Testing Library has unmounted the test's components. A
 * test still sees TanStack Query's timers behave normally while it runs.
 */
import { timeoutManager } from '@tanstack/svelte-query';

type Timer = ReturnType<typeof setTimeout>;

const pending = new Set<Timer>();

let installed = false;

/** Route TanStack Query's timers through a provider that records them. Safe to call twice. */
export function trackQueryTimers(): void {
  if (installed) return;
  installed = true;
  timeoutManager.setTimeoutProvider<Timer>({
    setTimeout(callback, delay) {
      const timer = setTimeout(() => {
        pending.delete(timer);
        callback();
      }, delay);
      pending.add(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer === undefined) return;
      pending.delete(timer);
      clearTimeout(timer);
    },
    setInterval(callback, delay) {
      const timer = setInterval(callback, delay);
      pending.add(timer);
      return timer;
    },
    clearInterval(timer) {
      if (timer === undefined) return;
      pending.delete(timer);
      clearInterval(timer);
    },
  });
}

/** How many TanStack Query timers are still scheduled. */
export function pendingQueryTimers(): number {
  return pending.size;
}

/** Cancel every TanStack Query timer still scheduled, so nothing a finished test made stays alive. */
export function clearQueryTimers(): void {
  for (const timer of pending) clearTimeout(timer);
  pending.clear();
}
