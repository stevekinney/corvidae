/**
 * A turn for `waitForCondition` that moves a manual runtime's clock forward as well as yielding to
 * the event loop. Bureau's session-persistence retries wait on the runtime timers, and a
 * `ManualRuntimeServices` fires none of them on its own, so a test that waits for a retried write
 * advances the clock a retry delay at a time between checks.
 */
import type { ManualRuntimeServices } from '@lostgradient/lifecycle';
import { yieldToPortableEventLoop } from '@lostgradient/weft';

/** Advances `runtime` by `stepMilliseconds` (one retry delay by default), then yields one event-loop turn. */
export function advancingTurn(
  runtime: ManualRuntimeServices,
  stepMilliseconds = 10,
): () => Promise<void> {
  return async () => {
    await runtime.advance(stepMilliseconds);
    // load-proof: the work this lets finish runs on in-memory storage and doubles and settles through promise continuations only, so a microtask drain completes it (checked by replacing the turn with one); no timer or I/O is pending
    await yieldToPortableEventLoop();
  };
}

/**
 * Awaits `work` while advancing `runtime` by `stepMilliseconds` between event-loop turns, so a
 * retry that sleeps on the runtime timers can finish. Rejects as `work` does.
 */
export async function withAdvancingClock<T>(
  runtime: ManualRuntimeServices,
  work: Promise<T>,
  stepMilliseconds = 10,
): Promise<T> {
  let settled = false;
  const guarded = work.finally(() => {
    settled = true;
  });
  guarded.catch(() => {});
  while (!settled) {
    await yieldToPortableEventLoop();
    if (!settled) await runtime.advance(stepMilliseconds);
  }
  return guarded;
}
