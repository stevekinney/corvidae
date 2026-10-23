/**
 * An agent's reply as A2A parts (COR-788): its text, and its generated media as file parts that
 * point at the asset route, never as inline bytes and never with a credential.
 *
 * - A `managed-asset` media part is a file part whose `url` is `<publicUrl>/assets/<id>/content`
 *   (the route `createBureauHandler` serves, which authorizes every read as the caller), with the
 *   part's `name` as `filename` and its media type as `mediaType`.
 * - A small `application/json` asset (at most {@link MAXIMUM_DATA_PART_BYTES}) that parses is a
 *   data part instead, holding the value. Any failure to read it (missing, too large, not JSON,
 *   not readable by the owner, a storage fault) leaves the file part: the projection never fails
 *   on it. Assets are immutable, so the same reply projects the same parts on every read, stream
 *   and push.
 * - A media part with a `remote-url` source is a file part with that URL. Inline bytes cannot
 *   leave a Bureau as a part of a stored reply, so a part still holding them (a source no asset
 *   service admitted) is not projected.
 * - Reasoning and provider server-tool content have no A2A part and are not projected.
 *
 * @module a2a-reply-parts
 */

import type { Part } from '@a2a-js/sdk';
import type { MediaContent, MultiModalContent } from 'conversationalist';

import type { AssetService } from '../assets/types.ts';
import { ASSETS_PATH_PREFIX } from './assets-mount.ts';

/** The largest `application/json` asset a reply publishes as a data part rather than a file part. */
export const MAXIMUM_DATA_PART_BYTES = 64 * 1024;

const JSON_MEDIA_TYPE = 'application/json';
const MEDIA_TYPES: ReadonlySet<string> = new Set(['image', 'audio', 'video', 'document', 'file']);

/** What projecting a reply reads besides its content. */
export type ReplyPartsContext = {
  /** The handler's public origin and base path. */
  readonly publicUrl: string;
  /** The asset service, or `undefined` when the Bureau has none (every asset stays a file part). */
  readonly assets: Pick<AssetService, 'inspect' | 'resolve'> | undefined;
  /** The owner whose assets the reply may name: the task's owner. */
  readonly owner: string;
};

/** The URL of an asset's content route under `publicUrl`. */
export function assetContentUrl(publicUrl: string, assetId: string): string {
  return `${publicUrl.replace(/\/+$/, '')}${ASSETS_PATH_PREFIX}/${encodeURIComponent(assetId)}/content`;
}

function metadataOf(content: MediaContent): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {
    ...(content.alt === undefined ? {} : { text: content.alt }),
    ...(content.caption === undefined ? {} : { caption: content.caption }),
    ...(content.transcript === undefined ? {} : { transcript: content.transcript }),
  };
  return Object.keys(metadata).length === 0 ? undefined : metadata;
}

function mediaTypeOf(value: string | undefined): string {
  return value === undefined ? '' : value.split(';', 1)[0]!.trim().toLowerCase();
}

/**
 * The JSON a small `application/json` asset holds, or `undefined` for any reason it cannot be
 * read: a projection never fails on a data part.
 */
async function jsonOf(
  context: ReplyPartsContext,
  assetId: string,
  declared: string,
): Promise<{ readonly value: unknown } | undefined> {
  const { assets } = context;
  if (assets === undefined || declared !== JSON_MEDIA_TYPE) return undefined;
  try {
    const principal = { id: context.owner };
    const descriptor = await assets.inspect(assetId, principal);
    if (
      descriptor.state !== 'available' ||
      mediaTypeOf(descriptor.mediaType) !== JSON_MEDIA_TYPE ||
      descriptor.byteLength === undefined ||
      descriptor.byteLength > MAXIMUM_DATA_PART_BYTES
    ) {
      return undefined;
    }
    const { content } = await assets.resolve({ assetId }, principal);
    if (content.kind !== 'bytes' || content.bytes.byteLength > MAXIMUM_DATA_PART_BYTES) {
      return undefined;
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(content.bytes);
    return { value: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}

async function mediaPart(
  content: MediaContent,
  context: ReplyPartsContext,
): Promise<Part | undefined> {
  const { source } = content;
  const filename = content.name ?? '';
  const mediaType = content.mimeType ?? '';
  const metadata = metadataOf(content);
  if (source.kind === 'managed-asset') {
    const json = await jsonOf(context, source.assetId, mediaTypeOf(content.mimeType));
    if (json !== undefined) {
      return { content: { $case: 'data', value: json.value }, metadata, filename, mediaType };
    }
    return {
      content: { $case: 'url', value: assetContentUrl(context.publicUrl, source.assetId) },
      metadata,
      filename,
      mediaType,
    };
  }
  if (source.kind === 'remote-url') {
    return { content: { $case: 'url', value: source.url }, metadata, filename, mediaType };
  }
  return undefined;
}

/** A reply's content as A2A parts, in order. */
export async function replyPartsOf(
  content: readonly MultiModalContent[],
  context: ReplyPartsContext,
): Promise<Part[]> {
  const parts: Part[] = [];
  for (const entry of content) {
    if (entry.type === 'text') {
      parts.push({
        content: { $case: 'text', value: entry.text },
        metadata: undefined,
        filename: '',
        mediaType: '',
      });
    } else if (MEDIA_TYPES.has(entry.type)) {
      const part = await mediaPart(entry as MediaContent, context);
      if (part !== undefined) parts.push(part);
    }
  }
  return parts;
}
