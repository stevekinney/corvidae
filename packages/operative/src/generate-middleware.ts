import {
  readBackendDescriptors,
  unionBackendDescriptors,
  withBackendDescriptors,
} from './providers/backend-descriptor-attachment';
import {
  generateAdmitsMedia,
  noBackendAdmitsMedia,
  requestMediaRequirements,
} from './providers/media-dispatch';
import type { GenerateFunction, GenerateMiddleware } from './types';

/**
 * Applies middleware right-to-left (first in list = outermost wrapper).
 *
 * The composed function reports the base's backend descriptors when the
 * outermost middleware attached none of its own (COR-716): a wrapper that
 * drops them would leave media admission with nothing to cost against, so
 * every part would be refused as `no-estimator`.
 */
export function composeGenerate(
  base: GenerateFunction,
  ...middleware: GenerateMiddleware[]
): GenerateFunction {
  const composed = middleware.reduceRight((next, mw) => mw(next), base);
  return readBackendDescriptors(composed).length > 0 || composed === base
    ? composed
    : withBackendDescriptors(composed, readBackendDescriptors(base));
}

/**
 * Tries providers in order; falls back on error.
 *
 * Attaches the ordered union of every provider's attached
 * `BackendDescriptor`(s), deduplicated by `(provider, endpoint, model)`
 * (AB-64 AC2, AB-245, AB-288) — see `unionBackendDescriptors` — onto the
 * returned wrapper, so an Agent whose generate is `createFallbackGenerate`'s
 * output reports the routed or fixed mode rather than opaque.
 */
export function createFallbackGenerate(options: {
  providers: GenerateFunction[];
  shouldFallback?: ((error: unknown) => boolean) | undefined;
}): GenerateFunction {
  const { providers, shouldFallback = () => true } = options;

  if (providers.length === 0) {
    throw new Error('createFallbackGenerate requires at least one provider');
  }

  const wrapped: GenerateFunction = async (context) => {
    // COR-716: only the providers whose backends admit every media part are tried.
    const requirements = requestMediaRequirements(context);
    const admitting = providers.filter((provider) => generateAdmitsMedia(provider, requirements));
    if (admitting.length === 0) throw noBackendAdmitsMedia(context, 'no-backend-admits-media');
    let lastError: unknown;
    for (const provider of admitting) {
      try {
        return await provider(context);
      } catch (error) {
        lastError = error;
        if (!shouldFallback(error)) {
          throw error;
        }
      }
    }
    throw lastError;
  };

  return withBackendDescriptors(
    wrapped,
    unionBackendDescriptors(providers.map((provider) => readBackendDescriptors(provider))),
  );
}
