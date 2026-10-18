/**
 * The media filter every dispatcher among backends shares (COR-716): routing,
 * fallover, and fallback each offer a request only to the backends that admit
 * every part of it, judged by `evaluateInputMedia` on the exact context the
 * dispatcher receives, which is the context run-step admission just derived
 * `resolvedSources` for. A generate function that reports no backend is opaque
 * and is kept: nothing says it cannot take the media. A request no candidate
 * admits is refused, typed, before any provider call.
 */
import { MediaAdmissionError } from '../errors.ts';
import { readBackendDescriptors } from './backend-descriptor-attachment.ts';
import { evaluateInputMedia, type InputMediaRequirement, locateInputMedia } from './selection.ts';
import type { GenerateContext, GenerateFunction } from './types.ts';

/** The media requirements of the request a dispatcher received, in order. */
export function requestMediaRequirements(
  context: GenerateContext,
): readonly InputMediaRequirement[] {
  return locateInputMedia(context.conversation, context.resolvedSources).map(
    ({ requirement }) => requirement,
  );
}

/**
 * Whether `generate` can take a request with these media requirements: it
 * reports no backend, or at least one of its backends admits every part.
 */
export function generateAdmitsMedia(
  generate: GenerateFunction,
  requirements: readonly InputMediaRequirement[],
): boolean {
  if (requirements.length === 0) return true;
  const descriptors = readBackendDescriptors(generate);
  return (
    descriptors.length === 0 ||
    descriptors.some((descriptor) => evaluateInputMedia(descriptor, requirements).eligible)
  );
}

/** The typed refusal for a request none of a dispatcher's candidates admits. */
export function noBackendAdmitsMedia(
  context: GenerateContext,
  reason: 'no-route-admits-media' | 'no-backend-admits-media',
): MediaAdmissionError {
  return new MediaAdmissionError(
    locateInputMedia(context.conversation, context.resolvedSources).map(
      ({ messageId, partIndex, part }) => ({
        messageId,
        partIndex,
        modality: part.type,
        outcome: 'unsupported' as const,
        reason,
      }),
    ),
  );
}
