/**
 * Memoize an asynchronous attempt until it fails.
 *
 * Concurrent and later callers share one in-flight or successful attempt. A
 * rejection is not remembered: the next call starts a fresh attempt, so a
 * transient failure (a dynamic import whose chunk request dropped, say) does not
 * leave every later caller replaying the same rejection. Only the attempt that
 * failed is forgotten, so a late rejection cannot discard a newer attempt.
 */
export function memoizeUntilRejected<T>(attempt: () => Promise<T>): () => Promise<T> {
  let current: Promise<T> | undefined;
  return () => {
    if (current !== undefined) return current;
    const started = attempt();
    current = started;
    void started.catch(() => {
      if (current === started) current = undefined;
    });
    return started;
  };
}
