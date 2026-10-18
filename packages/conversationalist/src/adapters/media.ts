/**
 * Shared media-part plumbing for the provider adapters (COR-716).
 *
 * Every outbound adapter reads a media part's `ContentSource`, decides which
 * wire form its provider accepts, records one {@link ContentPartLineage} entry
 * per delivered part, and rejects with an {@link UnsupportedContentError} for
 * any part it cannot carry. Nothing here substitutes marker prose, an empty
 * string, or text alone for a part.
 */
import {
  ConversationalistError,
  UnsupportedContentError,
  type UnsupportedContentReason,
} from '../errors';
import {
  BASE64_REQUIREMENT,
  baseMimeType,
  dataUrlDefect,
  isDecodableBase64,
  isDocumentMimeType,
  splitDataUrl,
} from '../media-types';
import type {
  ContentPartLineage,
  ContentSource,
  ContentTransform,
  MediaContent,
  Modality,
  MultiModalContent,
} from '../multi-modal';

export type AdapterProvider = ContentPartLineage['provider'];

/**
 * A source an operative-side resolver has projected to a kind a provider
 * accepts. Safety is carried for the guardrail; adapters ignore it.
 */
export interface ResolvedMediaSource {
  readonly outcome: 'resolved';
  readonly source: Extract<
    ContentSource,
    { kind: 'inline' | 'data-url' | 'remote-url' | 'provider-file' }
  >;
  readonly mimeType?: string | undefined;
  readonly byteLength?: number | undefined;
  readonly safety: 'clean' | 'flagged' | 'unknown';
}

/** Resolved sources, keyed `${messageId}:${partIndex}`. */
export type ResolvedMediaSources = ReadonlyMap<string, ResolvedMediaSource>;

/** The key a part's resolved source is stored under. */
export function resolvedSourceKey(messageId: string, partIndex: number): string {
  return `${messageId}:${partIndex}`;
}

/** Options every outbound adapter accepts for media handling. */
export interface MediaExportOptions {
  /** Sources an operative-side resolver projected to an accepted kind. */
  sources?: ResolvedMediaSources | undefined;
}

/** Per-message state an adapter threads through content conversion. */
export interface MediaExportContext {
  readonly provider: AdapterProvider;
  readonly messageId: string;
  readonly role: string;
  readonly lineage: ContentPartLineage[];
  readonly sources: ResolvedMediaSources | undefined;
}

export function createMediaExportContext(
  provider: AdapterProvider,
  message: { readonly id: string; readonly role: string },
  lineage: ContentPartLineage[],
  options: MediaExportOptions | undefined,
): MediaExportContext {
  return {
    provider,
    messageId: message.id,
    role: message.role,
    lineage,
    sources: options?.sources,
  };
}

/** Throws the typed pre-provider rejection for one part. */
export function rejectPart(
  context: MediaExportContext,
  partIndex: number,
  part: MultiModalContent,
  reason: UnsupportedContentReason,
  sourceKind?: ContentSource['kind'],
): never {
  throw new UnsupportedContentError({
    provider: context.provider,
    messageId: context.messageId,
    partIndex,
    partType: part.type,
    ...(sourceKind !== undefined ? { sourceKind } : {}),
    reason,
  });
}

/** A media part's source after any resolver projection. */
export interface EffectiveSource {
  readonly source: ContentSource;
  readonly mimeType: string | undefined;
  readonly resolved: boolean;
}

/**
 * The one precedence rule for the media type that names a part's bytes: the resolver's
 * type, then the type the data URL itself declares, then the part's stored `mimeType`.
 * The first two describe the bytes being sent; the stored type is only a label that can
 * go stale. Every exporter, provider and protocol alike, reads the type through this.
 */
export function effectiveMimeType(
  source: ContentSource,
  resolvedMimeType: string | undefined,
  storedMimeType: string | undefined,
): string | undefined {
  return (
    resolvedMimeType ??
    (source.kind === 'data-url' ? parseDataUrl(source.url)?.mimeType : undefined) ??
    storedMimeType
  );
}

export function effectiveSource(
  context: MediaExportContext,
  partIndex: number,
  part: MediaContent,
): EffectiveSource {
  const resolved = context.sources?.get(resolvedSourceKey(context.messageId, partIndex));
  if (resolved !== undefined) {
    return {
      source: resolved.source,
      mimeType: effectiveMimeType(resolved.source, resolved.mimeType, part.mimeType),
      resolved: true,
    };
  }
  return {
    source: part.source,
    mimeType: effectiveMimeType(part.source, undefined, part.mimeType),
    resolved: false,
  };
}

/** Records the lineage entry for one delivered media part. */
export function recordLineage(
  context: MediaExportContext,
  partIndex: number,
  part: MediaContent,
  effective: EffectiveSource,
  delivered: {
    to: ContentSource['kind'];
    transform: ContentTransform;
    providerFileId?: string | undefined;
    originalMimeType?: string | undefined;
  },
): void {
  const original = part.source;
  context.lineage.push({
    messageId: context.messageId,
    partIndex,
    modality: part.type satisfies Modality,
    provider: context.provider,
    from: original.kind,
    to: delivered.to,
    transform: effective.resolved ? 'resolved' : delivered.transform,
    ...(delivered.providerFileId !== undefined ? { providerFileId: delivered.providerFileId } : {}),
    ...(delivered.originalMimeType !== undefined
      ? { originalMimeType: delivered.originalMimeType }
      : {}),
    ...(original.kind === 'managed-asset'
      ? {
          assetId: original.assetId,
          ...(original.revision !== undefined ? { revision: original.revision } : {}),
        }
      : {}),
  });
}

/** Bytes a provider takes as a base64 block. */
export interface Base64Payload {
  readonly data: string;
  readonly mimeType: string | undefined;
  readonly kind: 'inline' | 'data-url';
}

/**
 * Normalizes an `inline` or `data-url` source to base64 bytes plus the media
 * type the data URL header declared. Returns `undefined` for any other kind.
 */
export function toBase64Payload(source: ContentSource): Base64Payload | undefined {
  if (source.kind === 'inline') {
    return {
      data: source.encoding === 'base64' ? source.data : encodeUtf8Base64(source.data),
      mimeType: undefined,
      kind: 'inline',
    };
  }
  if (source.kind === 'data-url') {
    const parsed = parseDataUrl(source.url);
    return parsed === undefined ? undefined : { ...parsed, kind: 'data-url' };
  }
  return undefined;
}

/**
 * Parses `data:[<mediatype>][;base64],<data>` through {@link splitDataUrl}; returns
 * base64 bytes and the (lower-cased) media type. The base64 flag is read without
 * regard to case, and a percent-encoded payload is re-encoded as base64.
 */
export function parseDataUrl(
  url: string,
): { data: string; mimeType: string | undefined } | undefined {
  const split = splitDataUrl(url);
  if (split === undefined || split.payload === '') return undefined;
  if (split.isBase64) return { data: split.payload, mimeType: split.mimeType };
  try {
    return { data: encodeUtf8Base64(decodeURIComponent(split.payload)), mimeType: split.mimeType };
  } catch {
    return undefined;
  }
}

export function encodeUtf8Base64(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Builds the `inline` source a provider's base64 block maps back to. Third-party
 * bytes are checked here, at the mapping boundary: base64 that would not decode
 * is refused with the adapter's own mapping error, which names what base64
 * requires, rather than stored as a source the content schema refuses later
 * with a generic message.
 */
export function inlineBase64Source(
  data: string,
  invalid: (reason: string) => Error = (reason) =>
    new ConversationalistError('error:validation', `Cannot map inline bytes: ${reason}.`),
): Extract<ContentSource, { kind: 'inline' }> {
  if (!isDecodableBase64(data)) throw invalid(`the ${BASE64_REQUIREMENT}`);
  return { kind: 'inline', data, encoding: 'base64' };
}

/**
 * Maps a URL a provider reports (or a caller passes) to its `ContentSource`:
 * `data:` becomes `data-url`, `http:` and `https:` become `remote-url`. Any
 * other scheme (`s3:`, `gs:`, `file:`) is not a URL a `remote-url` source can
 * hold, and a data URL whose payload does not decode names no bytes, so both
 * are refused with `invalid(url, reason)` rather than stored as a source the
 * content schema would later reject. Adapters pass their own mapping error.
 */
export function sourceFromUrl(
  url: string,
  invalid: (url: string, reason: string) => Error = (rejected, reason) =>
    new ConversationalistError('error:validation', `Cannot map the URL "${rejected}": ${reason}.`),
): ContentSource {
  if (url.slice(0, 'data:'.length).toLowerCase() === 'data:') {
    const defect = dataUrlDefect(url);
    if (defect !== undefined) throw invalid(url, defect);
    return { kind: 'data-url', url };
  }
  if (/^https?:\/\//i.test(url)) return { kind: 'remote-url', url };
  throw invalid(url, 'only http, https, and data URLs are media sources');
}

/**
 * The modality a media type belongs to, by the same table the schema checks a
 * declared type against: `image/*`, `audio/*`, and `video/*` are those modalities;
 * a document type (PDF, `text/*`, structured text, RTF, and the office formats,
 * see {@link isDocumentMimeType}) is a document; any other type is a generic file.
 * Every inbound adapter classifies through this, so what one provider sends in is
 * what its own exporter accepts back out.
 */
export function modalityFromMimeType(
  mimeType: string | undefined,
): Exclude<Modality, 'text'> | undefined {
  if (mimeType === undefined) return undefined;
  const base = baseMimeType(mimeType);
  const family = base.split('/')[0];
  if (family === 'image' || family === 'audio' || family === 'video') return family;
  return isDocumentMimeType(base) ? 'document' : 'file';
}

/** Builds a media part with only the optional fields that are present. */
export function createMediaPart(
  type: MediaContent['type'],
  source: ContentSource,
  fields: {
    mimeType?: string | undefined;
    name?: string | undefined;
    alt?: string | undefined;
  } = {},
): MediaContent {
  return {
    type,
    source,
    ...(fields.mimeType !== undefined ? { mimeType: fields.mimeType } : {}),
    ...(fields.name !== undefined ? { name: fields.name } : {}),
    ...(fields.alt !== undefined ? { alt: fields.alt } : {}),
  };
}
