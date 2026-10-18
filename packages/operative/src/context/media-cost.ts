/**
 * Media cost accounting (COR-716).
 *
 * A media part is never priced at zero. {@link createCatalogMediaCostEstimator}
 * costs a part against the backends a run can call, using each backend's
 * declared modalities, source forms, MIME families, and limits. It returns a
 * typed {@link MediaCostOutcome}: `estimated` admits the part; `unsupported`
 * and `unbounded` do not.
 *
 * The token figure is an estimate derived from the part's byte length and a
 * per-modality rate, not a provider count, and it is not an upper bound: a
 * text-heavy document costs far more tokens per byte than the rate assumes. An
 * underestimate surfaces as a typed provider context-overflow error, which the
 * overflow mutator recovers from by compacting. A caller with a
 * provider counter supplies its own {@link MediaCostEstimator} (and reports
 * `basis: 'provider-count'`); this catalog estimator never claims that basis.
 */
import type {
  ContentSource,
  MediaContent,
  MimeFamily,
  ResolvedMediaSources,
} from 'conversationalist';
import { parseDataUrl } from 'conversationalist';

import type { BackendDescriptor } from '../providers/model-catalog';
import type { MediaCostEstimator, MediaCostOutcome, MediaPartPosition } from './types';

/**
 * Estimated tokens per KiB of media bytes, by modality. Images and audio are
 * priced by the provider per image or per second rather than per byte, so these
 * rates lean high for them; documents are the weak spot, because a PDF of dense
 * text costs more tokens per byte than 3.
 */
export const MEDIA_TOKENS_PER_KIBIBYTE = Object.freeze({
  image: 2,
  document: 3,
  audio: 4,
  video: 4,
  file: 1,
} as const);

/** A floor so an empty-looking payload still costs something. */
const MINIMUM_MEDIA_TOKENS = 1;

/** The MIME family a media type belongs to, or `undefined` when none is declared. */
export function mimeFamilyOf(mimeType: string | undefined): MimeFamily | undefined {
  if (mimeType === undefined) return undefined;
  const lowered = mimeType.toLowerCase();
  const family = lowered.split('/')[0];
  switch (family) {
    case 'text':
    case 'image':
    case 'audio':
    case 'video':
    case 'font':
    case 'model':
      return family;
    default:
      return lowered === 'application/pdf' ? 'document' : 'application';
  }
}

/** The byte length an inline or data-URL source carries, or `undefined` when it is not carried. */
export function sourceByteLength(source: ContentSource): number | undefined {
  if (source.kind === 'inline') {
    return source.encoding === 'base64'
      ? base64ByteLength(source.data)
      : new TextEncoder().encode(source.data).byteLength;
  }
  if (source.kind === 'data-url') {
    const parsed = parseDataUrl(source.url);
    return parsed === undefined ? undefined : base64ByteLength(parsed.data);
  }
  return undefined;
}

function base64ByteLength(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/** Options for {@link createCatalogMediaCostEstimator}. */
export interface CatalogMediaCostEstimatorOptions {
  /**
   * Sources a resolver projected to an accepted kind. A part with an entry is
   * costed against the resolved source, MIME type, and byte length.
   */
  readonly resolvedSources?: ResolvedMediaSources | undefined;
}

/**
 * Costs media against `descriptors`: the backends the run can call. Only the
 * descriptors that accept the part's modality at all are consulted, and the
 * part is refused as `modality-not-accepted` only when none does. The part must
 * be acceptable to every consulted descriptor (the run may be served by any of
 * them). A part of unknown size is costed at the per-part byte cap its
 * modality carries, and is `size-unknown` only when a consulted descriptor
 * declares no such cap.
 */
export function createCatalogMediaCostEstimator(
  descriptors: readonly BackendDescriptor[],
  options: CatalogMediaCostEstimatorOptions = {},
): MediaCostEstimator {
  return (part: MediaContent, position: MediaPartPosition): MediaCostOutcome => {
    const base = { ...position, modality: part.type } as const;
    const resolved = options.resolvedSources?.get(`${position.messageId}:${position.partIndex}`);
    const source = resolved?.source ?? part.source;
    const mimeType = resolved?.mimeType ?? part.mimeType ?? dataUrlMimeType(source);

    if (descriptors.length === 0) {
      return { ...base, outcome: 'unbounded', reason: 'no-estimator' };
    }
    const accepting = descriptors.filter((descriptor) => descriptor.modalities[part.type].input);
    if (accepting.length === 0) {
      return { ...base, outcome: 'unsupported', reason: 'modality-not-accepted' };
    }
    if (
      accepting.some(
        (descriptor) =>
          !descriptor.modalities[part.type].sourceForms.includes(source.kind) ||
          // A file handle only works at the provider that issued it.
          (source.kind === 'provider-file' && source.provider !== descriptor.provider),
      )
    ) {
      return { ...base, outcome: 'unsupported', reason: 'source-form-not-accepted' };
    }
    const family = mimeFamilyOf(mimeType);
    if (
      family !== undefined &&
      accepting.some((descriptor) => !descriptor.mimeFamilies.includes(family))
    ) {
      return { ...base, outcome: 'unsupported', reason: 'mime-family-not-accepted' };
    }

    const knownByteLength = resolved?.byteLength ?? sourceByteLength(source);
    const caps = accepting.map((descriptor) => perPartByteCap(descriptor, part.type));
    const byteLength =
      knownByteLength ??
      (caps.every((cap): cap is number => cap !== undefined) ? Math.max(...caps) : undefined);
    if (byteLength === undefined) {
      return { ...base, outcome: 'unbounded', reason: 'size-unknown' };
    }
    const exceedsLimit = accepting.some((descriptor) =>
      descriptor.mediaLimits.some(
        (limit) =>
          limit.modality === part.type &&
          limit.scope === 'per-part' &&
          limit.maxBytes !== undefined &&
          byteLength > limit.maxBytes,
      ),
    );
    if (exceedsLimit) {
      return { ...base, outcome: 'unbounded', reason: 'media-limit-exceeded' };
    }
    const tokens = Math.max(
      MINIMUM_MEDIA_TOKENS,
      Math.ceil((byteLength / 1024) * MEDIA_TOKENS_PER_KIBIBYTE[part.type]),
    );
    return { ...base, outcome: 'estimated', tokens, basis: 'catalog-estimate' };
  };
}

/** The smallest per-part byte cap a descriptor declares for a modality, if any. */
function perPartByteCap(
  descriptor: BackendDescriptor,
  modality: MediaContent['type'],
): number | undefined {
  const caps = descriptor.mediaLimits
    .filter((limit) => limit.modality === modality && limit.scope === 'per-part')
    .flatMap((limit) => (limit.maxBytes === undefined ? [] : [limit.maxBytes]));
  return caps.length === 0 ? undefined : Math.min(...caps);
}

function dataUrlMimeType(source: ContentSource): string | undefined {
  return source.kind === 'data-url' ? parseDataUrl(source.url)?.mimeType : undefined;
}
