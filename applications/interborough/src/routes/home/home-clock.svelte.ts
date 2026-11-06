/**
 * The clock Home's cards read: the page's `Date.now()`, read again each minute, so a time that says
 * "4 min ago" and the day at the top of the page stay true while the page is left open.
 */

/** How often the clock is read again. */
export const HOME_CLOCK_MILLISECONDS = 60_000;

/** Returns a function that reads the current time in epoch milliseconds. Call it while a component initializes. */
export function useMinuteClock(): () => number {
  let now = $state(Date.now());
  $effect(() => {
    // poll-reason: clock
    const timer = setInterval(() => {
      now = Date.now();
    }, HOME_CLOCK_MILLISECONDS);
    return () => clearInterval(timer);
  });
  return () => now;
}
