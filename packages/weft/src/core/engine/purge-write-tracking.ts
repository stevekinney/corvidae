import type { EngineInternals } from './internals.ts';

/**
 * Register a purge write in `internals.inFlightPurgeWrites` for as long as it is
 * pending. Storage calls cannot be cancelled, so async disposal waits for writes
 * already issued (a purge that half-lands is worse than a slower shutdown) but
 * never for the reads around them: every purge write checks `internals.disposed`
 * before it is issued, so a read still pending at disposal is safe to abandon.
 */
export function trackPurgeWrite<T>(internals: EngineInternals, write: Promise<T>): Promise<T> {
  internals.inFlightPurgeWrites.add(write);
  return write.finally(() => {
    internals.inFlightPurgeWrites.delete(write);
  });
}

/**
 * Settle every purge write issued before disposal. Never rejects: a failed write
 * is reported, if at all, by whoever issued it.
 */
export async function settleInFlightPurgeWrites(internals: EngineInternals): Promise<void> {
  await Promise.allSettled(internals.inFlightPurgeWrites);
}
