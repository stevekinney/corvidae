/**
 * `Bureau` has no method that sweeps expired reviews: its own maintenance does, on a timer or when
 * a manual host runs `runDurableMaintenance`. A test that holds approvals past their bindings runs
 * that pass at the clock reading it names and counts what the pass expired.
 */
import type { Bureau } from '../types';

/**
 * Runs one durable maintenance pass at `now` (the runtime clock when omitted) and resolves how
 * many reviews the pass moved to `expired`, counted as the `review.expired` events it dispatched.
 */
export async function expireReviews(bureau: Bureau, now?: number): Promise<number> {
  let expired = 0;
  const count = () => {
    expired += 1;
  };
  bureau.addEventListener('review.expired', count);
  try {
    await bureau.runDurableMaintenance(now);
  } finally {
    bureau.removeEventListener('review.expired', count);
  }
  return expired;
}
