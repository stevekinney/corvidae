import type { ContentPart, PartSource } from '@ag-ui/core';
import type { DocumentContent, ImageContent, MultiModalContent } from '../../multi-modal';
import { unsupportedAGUIContent } from './errors';

const DATA_URL_PATTERN = /^data:([^;,]+);base64,(.*)$/;
const UNNAMED_DOCUMENT_NAME = 'document';
const OCTET_STREAM_MEDIA_TYPE = 'application/octet-stream';

/**
 * Joins the text parts of content into the plain string an AG-UI message
 * carries. Any other part throws, because a text-only AG-UI message cannot hold
 * it: that is an `AGUIMappingError` naming the part rather than a silent drop.
 */
export function toAGUIText(
  content: string | ReadonlyArray<MultiModalContent>,
  role: string,
): string {
  if (typeof content === 'string') return content;
  const texts: string[] = [];
  for (const part of content) {
    if (part.type !== 'text') {
      throw unsupportedAGUIContent(
        part.type,
        `${role} messages carry only text in AG-UI, so ${part.type} content has no representation.`,
      );
    }
    texts.push(part.text);
  }
  return texts.join('\n\n');
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
        return { type: 'text', text: part.text };
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
  if (parts.length === 1 && parts[0]?.type === 'text') return parts[0].text;
  return parts;
}

function fromAGUIPart(part: ContentPart): MultiModalContent {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
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

function readMetadataString(metadata: unknown, key: string): string | undefined {
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  const value: unknown = (metadata as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}
