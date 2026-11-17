/**
 * How long until the next try of something that retries itself, in words: a hook's delivery that
 * failed and a workflow's plugin trigger that could not start both say "Next try in 40 seconds" the
 * same way, so a person reads one wording.
 *
 * @module next-try
 */

/** What is said when the try is due now, or past due. */
export const NEXT_TRY_DUE = 'a moment';

/**
 * How long until a try, in words: `40 seconds`, `2 minutes`, `3 hours`, and `a moment` when it is due.
 * Seconds below a minute and a half, minutes below an hour and a half, then hours.
 */
export function nextTryWords(nextAttemptAt: number, now: number): string {
  const seconds = Math.ceil((nextAttemptAt - now) / 1000);
  if (seconds <= 0) return NEXT_TRY_DUE;
  if (seconds < 90) return `${String(seconds)} ${seconds === 1 ? 'second' : 'seconds'}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${String(minutes)} minutes`;
  const hours = Math.round(minutes / 60);
  return `${String(hours)} ${hours === 1 ? 'hour' : 'hours'}`;
}
