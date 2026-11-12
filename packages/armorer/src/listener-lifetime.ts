/**
 * Ties one listener's lifetime to a caller's signal and an emitter's signal, and returns the signal
 * the listener is registered with: a controller of its own, aborted when either source aborts or
 * when `release` runs.
 *
 * Not `AbortSignal.any([external, emitterSignal])`: Bun collects a combined signal that only a
 * listener's `signal` option refers to, after which aborting its sources never removes the listener
 * (COR-2374). Here the sources hold the abort callbacks, and the callbacks hold the controller.
 */
export function bindListenerLifetime(
  external: AbortSignal | undefined,
  emitterSignal: AbortSignal,
): { readonly signal: AbortSignal; readonly release: () => void } {
  // The emitter's own signal is held by the emitter, so it needs no controller of its own.
  if (external === undefined) return { signal: emitterSignal, release: () => undefined };
  const controller = new AbortController();
  const release = (): void => controller.abort();
  if (external.aborted || emitterSignal.aborted) {
    release();
    return { signal: controller.signal, release };
  }
  const options = { once: true, signal: controller.signal };
  external.addEventListener('abort', release, options);
  emitterSignal.addEventListener('abort', release, options);
  return { signal: controller.signal, release };
}
