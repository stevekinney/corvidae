/**
 * Waits for `pending`, or rejects with the signal's reason as soon as it aborts, whichever comes
 * first. `pending` is always awaited, so a promise that fails after the race was lost is handled,
 * never reported as unhandled. The abort listener is removed once `pending` settles, so a
 * long-lived signal keeps none. With no signal it is `pending` itself.
 */
export function raceAbort<T>(pending: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return pending;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    void (async () => {
      try {
        resolve(await pending);
      } catch (error) {
        reject(error);
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    })();
  });
}
