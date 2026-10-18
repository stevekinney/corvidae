import type { ContentPart, PartSource } from '@ag-ui/core';
import {
  type ContentSource,
  type MediaContent,
  type MultiModalContent,
  type TextContent,
} from '../../multi-modal';
import type { JSONValue } from '../../types';
import {
  createMediaPart,
  encodeUtf8Base64,
  inlineBase64Source,
  parseDataUrl,
  sourceFromUrl,
} from '../media';
import { toJSONValue } from '../shared';
import { unsupportedAGUIContent } from './errors';

/**
 * Where a text-only AG-UI message (assistant, system, developer) keeps the text
 * parts it was written from, whenever one of them carries citations. The
 * message's own `content` is a plain string, so the parts and their citations
 * would otherwise be lost; import trusts the entry only if its parts join to
 * exactly the message's text.
 */
export const TEXT_PARTS_METADATA_KEY = 'conversationalist:textParts';

/**
 * Joins the text parts of content into the plain string a text-only AG-UI
 * message carries, and returns the metadata entry that keeps the parts when any
 * of them is cited. Any other part throws, because a text-only AG-UI message
 * cannot hold it: that is an `AGUIMappingError` naming the part rather than a
 * silent drop.
 */
export function toAGUIText(
  content: string | ReadonlyArray<MultiModalContent>,
  role: string,
): { text: string; metadata: Record<string, unknown> } {
  if (typeof content === 'string') return { text: content, metadata: {} };
  const parts: TextContent[] = [];
  for (const part of content) {
    if (part.type !== 'text') {
      throw unsupportedAGUIContent(
        part.type,
        `${role} messages carry only text in AG-UI, so ${part.type} content has no representation.`,
      );
    }
    parts.push(part);
  }
  return {
    text: parts.map((part) => part.text).join('\n\n'),
    metadata: parts.some((part) => part.citations !== undefined)
      ? { [TEXT_PARTS_METADATA_KEY]: parts }
      : {},
  };
}

/**
 * The text parts a text-only message was written from, when its metadata still
 * holds them and they still say what the message says.
 */
export function readTextParts(
  metadata: Record<string, unknown> | undefined,
  text: string,
): TextContent[] | undefined {
  const stored = readMetadataValue(metadata, TEXT_PARTS_METADATA_KEY);
  if (!Array.isArray(stored)) return undefined;
  const parts: TextContent[] = [];
  for (const entry of stored as unknown[]) {
    const part = readTextPart(entry);
    if (part === undefined) return undefined;
    parts.push(part);
  }
  return parts.map((part) => part.text).join('\n\n') === text ? parts : undefined;
}

function readTextPart(entry: unknown): TextContent | undefined {
  if (readMetadataValue(entry, 'type') !== 'text') return undefined;
  const text = readMetadataString(entry, 'text');
  if (text === undefined) return undefined;
  const citations = readMetadataValue(entry, 'citations');
  return {
    type: 'text',
    text,
    ...(citations !== undefined ? { citations: toJSONValue(citations) } : {}),
  };
}

/** Metadata without the entry that keeps a message's text parts. */
export function withoutTextParts(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (metadata === undefined) return undefined;
  const { [TEXT_PARTS_METADATA_KEY]: _parts, ...rest } = metadata;
  return rest;
}

/**
 * Converts message content to the `string | ContentPart[]` an AG-UI user or
 * tool message carries. Text, image, and document parts map; every other part
 * throws an `AGUIMappingError`.
 */
export function toAGUIContent(
  content: string | ReadonlyArray<MultiModalContent>,
  role: string,
): string | ContentPart[] {
  if (typeof content === 'string') return content;
  return content.map((part): ContentPart => {
    switch (part.type) {
      case 'text':
        return {
          type: 'text',
          text: part.text,
          ...(part.citations !== undefined ? { metadata: { citations: part.citations } } : {}),
        };
      case 'image':
      case 'audio':
      case 'video':
      case 'document':
        return toAGUIMediaPart(part);
      default:
        throw unsupportedAGUIContent(
          part.type,
          `${part.type} content in a ${role} message has no AG-UI part representation.`,
        );
    }
  });
}

/** Part metadata keys the AG-UI mapping owns; `alt` keeps its historic `text` key. */
function toAGUIMediaMetadata(part: MediaContent): Record<string, unknown> {
  return {
    ...(part.name !== undefined ? { name: part.name } : {}),
    ...(part.alt !== undefined ? { text: part.alt } : {}),
    ...(part.caption !== undefined ? { caption: part.caption } : {}),
    ...(part.transcript !== undefined ? { transcript: part.transcript } : {}),
    ...(part.extractedText !== undefined ? { extractedText: part.extractedText } : {}),
    ...(part.metadata !== undefined ? { metadata: part.metadata } : {}),
  };
}

function toAGUIMediaPart(
  part: MediaContent & { type: 'image' | 'audio' | 'video' | 'document' },
): ContentPart {
  const metadata = toAGUIMediaMetadata(part);
  return {
    type: part.type,
    source: toAGUIPartSource(part),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

function toAGUIPartSource(part: MediaContent): PartSource {
  const { source } = part;
  const mimeType = part.mimeType;
  switch (source.kind) {
    case 'inline':
    case 'data-url': {
      const data =
        source.kind === 'inline'
          ? {
              value: source.encoding === 'base64' ? source.data : encodeUtf8Base64(source.data),
              mimeType,
            }
          : parseDataUrl(source.url);
      const resolvedMimeType = mimeType ?? data?.mimeType;
      if (data === undefined || resolvedMimeType === undefined) {
        throw unsupportedAGUIContent(
          part.type,
          'an AG-UI data source requires bytes and a media type.',
        );
      }
      return {
        type: 'data',
        value: 'value' in data ? data.value : data.data,
        mimeType: resolvedMimeType,
      };
    }
    case 'remote-url':
      return { type: 'url', value: source.url, ...(mimeType !== undefined ? { mimeType } : {}) };
    case 'provider-file':
      return {
        type: 'file',
        value: source.providerFileId,
        provider: source.provider,
        ...(mimeType !== undefined ? { mimeType } : {}),
      };
    default:
      throw unsupportedAGUIContent(
        part.type,
        `a ${source.kind} source has no AG-UI part source representation.`,
      );
  }
}

/**
 * Converts the content of an AG-UI user or tool message to Conversationalist
 * content. A lone text part collapses to a string. A provider file handle
 * without a named provider has no Conversationalist representation and throws
 * an `AGUIMappingError`.
 */
export function fromAGUIContent(
  content: string | ReadonlyArray<ContentPart>,
): string | MultiModalContent[] {
  if (typeof content === 'string') return content;
  const parts = content.map(fromAGUIPart);
  if (parts.length === 0) return '';
  if (parts.length === 1 && parts[0]?.type === 'text' && parts[0].citations === undefined)
    return parts[0].text;
  return parts;
}

function fromAGUIPart(part: ContentPart): MultiModalContent {
  switch (part.type) {
    case 'text': {
      const citations = readMetadataValue(part.metadata, 'citations');
      return {
        type: 'text',
        text: part.text,
        ...(citations !== undefined ? { citations: toJSONValue(citations) } : {}),
      };
    }
    case 'image':
    case 'audio':
    case 'video':
    case 'document':
      return fromAGUIMediaPart(part);
    default: {
      // Every ContentPart kind the pinned `@ag-ui/core` defines is mapped above;
      // a newer protocol's extra kind is named rather than dropped.
      const kind = String((part as { type?: unknown }).type);
      throw unsupportedAGUIContent(
        kind,
        `${kind} parts have no Conversationalist content representation.`,
      );
    }
  }
}

function fromAGUISource(part: Extract<ContentPart, { source: PartSource }>): ContentSource {
  const { source } = part;
  if (source.type === 'file') {
    if (source.provider === undefined || source.provider === '') {
      throw unsupportedAGUIContent(
        part.type,
        'a provider file handle without a named provider cannot be resolved here.',
      );
    }
    return { kind: 'provider-file', provider: source.provider, providerFileId: source.value };
  }
  return source.type === 'url'
    ? sourceFromUrl(source.value, (url, reason) =>
        unsupportedAGUIContent(part.type, `its URL "${url}" cannot be a media source: ${reason}.`),
      )
    : inlineBase64Source(source.value, (reason) =>
        unsupportedAGUIContent(part.type, `its data is not base64 that decodes: ${reason}.`),
      );
}

function fromAGUIMediaPart(
  part: Extract<ContentPart, { type: 'image' | 'audio' | 'video' | 'document' }>,
): MediaContent {
  const metadata = readMetadataValue(part.metadata, 'metadata');
  const fields = {
    name: readMetadataString(part.metadata, 'name'),
    alt: readMetadataString(part.metadata, 'text'),
    caption: readMetadataString(part.metadata, 'caption'),
    transcript: readMetadataString(part.metadata, 'transcript'),
    extractedText: readMetadataString(part.metadata, 'extractedText'),
  };
  const media = createMediaPart(part.type, fromAGUISource(part), {
    mimeType: part.source.mimeType,
    name: fields.name,
  });
  return {
    ...media,
    ...(fields.alt !== undefined ? { alt: fields.alt } : {}),
    ...(fields.caption !== undefined ? { caption: fields.caption } : {}),
    ...(fields.transcript !== undefined ? { transcript: fields.transcript } : {}),
    ...(fields.extractedText !== undefined ? { extractedText: fields.extractedText } : {}),
    ...(isJSONRecord(metadata) ? { metadata } : {}),
  };
}

function isJSONRecord(value: unknown): value is Record<string, JSONValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readMetadataValue(metadata: unknown, key: string): unknown {
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  const entry = Object.entries(metadata).find(([name]) => name === key);
  return entry?.[1];
}

function readMetadataString(metadata: unknown, key: string): string | undefined {
  const value = readMetadataValue(metadata, key);
  return typeof value === 'string' ? value : undefined;
}
