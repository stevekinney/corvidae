/**
 * Shared media-part plumbing for the provider adapters (COR-716).
 *
 * Every outbound adapter reads a media part's `ContentSource`, decides which
 * wire form its provider accepts, records one {@link ContentPartLineage} entry
 * per delivered part, and rejects with an {@link UnsupportedContentError} for
 * any part it cannot carry. Nothing here substitutes marker prose, an empty
 * string, or text alone for a part.
 */
import { UnsupportedContentError, type UnsupportedContentReason } from '../errors';
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

export function effectiveSource(
  context: MediaExportContext,
  partIndex: number,
  part: MediaContent,
): EffectiveSource {
  const resolved = context.sources?.get(resolvedSourceKey(context.messageId, partIndex));
  if (resolved !== undefined) {
    return {
      source: resolved.source,
      mimeType: part.mimeType ?? resolved.mimeType,
      resolved: true,
    };
  }
  return { source: part.source, mimeType: part.mimeType, resolved: false };
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

/** Parses `data:[<mediatype>][;base64],<data>`; returns base64 bytes and the media type. */
export function parseDataUrl(
  url: string,
): { data: string; mimeType: string | undefined } | undefined {
  if (!url.startsWith('data:')) return undefined;
  const comma = url.indexOf(',');
  if (comma === -1) return undefined;
  const header = url.slice('data:'.length, comma);
  const payload = url.slice(comma + 1);
  const segments = header.split(';');
  const isBase64 = segments.includes('base64');
  const mime = segments[0] === undefined || segments[0] === '' ? undefined : segments[0];
  if (payload === '') return undefined;
  if (isBase64) return { data: payload, mimeType: mime };
  try {
    return { data: encodeUtf8Base64(decodeURIComponent(payload)), mimeType: mime };
  } catch {
    return undefined;
  }
}

export function encodeUtf8Base64(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Builds the `inline` source a provider's base64 block maps back to. */
export function inlineBase64Source(data: string): Extract<ContentSource, { kind: 'inline' }> {
  return { kind: 'inline', data, encoding: 'base64' };
}

/**
 * Maps a URL a provider reports (or a caller passes) to its `ContentSource`:
 * `data:` becomes `data-url`, anything else `remote-url`.
 */
export function sourceFromUrl(url: string): ContentSource {
  return url.startsWith('data:') ? { kind: 'data-url', url } : { kind: 'remote-url', url };
}

/**
 * The modality a media type belongs to. `application/pdf` and `text/*` are
 * documents; any other `application/*` is a generic file.
 */
export function modalityFromMimeType(
  mimeType: string | undefined,
): Exclude<Modality, 'text'> | undefined {
  if (mimeType === undefined) return undefined;
  const family = mimeType.split('/')[0]?.toLowerCase();
  if (family === 'image' || family === 'audio' || family === 'video') return family;
  if (mimeType.toLowerCase() === 'application/pdf' || family === 'text') return 'document';
  return 'file';
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
