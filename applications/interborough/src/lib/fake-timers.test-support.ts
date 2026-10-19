/**
 * Waiting for the application under Bun's fake timers. Testing Library's `waitFor` cannot be used
 * there: it expects the fake clock of Jest, and under Bun's it gives up before the page has
 * rendered. These two do the same job by yielding to the event loop with `setImmediate`, which Bun
 * does not fake (`setTimeout` and `Bun.sleep` would wait on the fake clock for ever), and by
 * running the timers that are due now, which is where TanStack Query schedules its notifications.
 */
import { jest } from 'bun:test';

/** Lets the stubbed responses and the query cache's own scheduling run, without moving the clock. */
export async function settle(rounds = 8): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    jest.advanceTimersByTime(0);
  }
}

/** Settles until `condition` holds, or fails after `limit` rounds with the condition's own error. */
export async function until(condition: () => void, limit = 60): Promise<void> {
  let failure: unknown;
  for (let round = 0; round < limit; round += 1) {
    try {
      condition();
      return;
    } catch (error) {
      failure = error;
    }
    await settle(1);
  }
  throw failure;
}
