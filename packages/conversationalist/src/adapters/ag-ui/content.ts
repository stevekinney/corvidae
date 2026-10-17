import type { ContentPart, PartSource } from '@ag-ui/core';
import type {
  DocumentContent,
  ImageContent,
  MultiModalContent,
  TextContent,
} from '../../multi-modal';
import { toJSONValue } from '../shared';
import { unsupportedAGUIContent } from './errors';

const DATA_URL_PATTERN = /^data:([^;,]+);base64,(.*)$/;
const UNNAMED_DOCUMENT_NAME = 'document';
const OCTET_STREAM_MEDIA_TYPE = 'application/octet-stream';

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
        return toAGUIImagePart(part);
      case 'document':
        return toAGUIDocumentPart(part);
      default:
        throw unsupportedAGUIContent(
          part.type,
          `${part.type} content in a ${role} message has no AG-UI part representation.`,
        );
    }
  });
}

function toAGUIImagePart(image: ImageContent): ContentPart {
  const dataUrl = DATA_URL_PATTERN.exec(image.url);
  const source: PartSource = dataUrl
    ? { type: 'data', value: dataUrl[2] ?? '', mimeType: image.mimeType ?? dataUrl[1] ?? '' }
    : {
        type: 'url',
        value: image.url,
        ...(image.mimeType !== undefined ? { mimeType: image.mimeType } : {}),
      };
  return {
    type: 'image',
    source,
    ...(image.text !== undefined ? { metadata: { text: image.text } } : {}),
  };
}

function toAGUIDocumentPart(document: DocumentContent): ContentPart {
  const source: PartSource =
    document.source.kind === 'base64'
      ? { type: 'data', value: document.source.data, mimeType: document.mimeType }
      : { type: 'url', value: document.source.uri, mimeType: document.mimeType };
  return { type: 'document', source, metadata: { name: document.name } };
}

/**
 * Converts the content of an AG-UI user or tool message to Conversationalist
 * content. A lone text part collapses to a string. Audio, video, and
 * provider-file-handle sources have no Conversationalist representation and
 * throw an `AGUIMappingError`.
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
      return fromAGUIImagePart(part);
    case 'document':
      return fromAGUIDocumentPart(part);
    default:
      throw unsupportedAGUIContent(
        part.type,
        `${part.type} parts have no Conversationalist content representation.`,
      );
  }
}

function fromAGUIImagePart(part: Extract<ContentPart, { type: 'image' }>): ImageContent {
  const { source } = part;
  if (source.type === 'file') {
    throw unsupportedAGUIContent('image', 'a provider file handle cannot be resolved here.');
  }
  const text = readMetadataString(part.metadata, 'text');
  const mimeType = source.mimeType;
  return {
    type: 'image',
    url: source.type === 'url' ? source.value : `data:${mimeType};base64,${source.value}`,
    ...(mimeType !== undefined ? { mimeType } : {}),
    ...(text !== undefined ? { text } : {}),
  };
}

function fromAGUIDocumentPart(part: Extract<ContentPart, { type: 'document' }>): DocumentContent {
  const { source } = part;
  if (source.type === 'file') {
    throw unsupportedAGUIContent('document', 'a provider file handle cannot be resolved here.');
  }
  return {
    type: 'document',
    name: readMetadataString(part.metadata, 'name') ?? UNNAMED_DOCUMENT_NAME,
    mimeType: source.mimeType ?? OCTET_STREAM_MEDIA_TYPE,
    source:
      source.type === 'data'
        ? { kind: 'base64', data: source.value }
        : { kind: 'reference', uri: source.value },
  };
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
