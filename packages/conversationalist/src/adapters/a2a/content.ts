import type {
  DocumentContent,
  ImageContent,
  MultiModalContent,
  TextContent,
} from '../../multi-modal';
import type { JSONValue } from '../../types';
import { parseJSONValue, toJSONValue } from '../shared';
import { A2AMappingError, unsupportedA2AContent } from './errors';
import type { A2ADataPart, A2APart, A2ARawPart, A2AStruct, A2AUrlPart } from './proto-types';

/** Media type assumed for a `data` part that declares none. */
const JSON_MEDIA_TYPE = 'application/json';
/** Media type assumed for a file part that declares none. */
const OCTET_STREAM_MEDIA_TYPE = 'application/octet-stream';

const DATA_URL_PATTERN = /^data:([^;,]+);base64,(.*)$/;

/**
 * Converts one Conversationalist content part to an A2A `Part`.
 *
 * - `text` becomes a `text` part; citations travel in `metadata.citations`.
 * - `image` becomes a `raw` part when its URL is a base64 data URL, otherwise
 *   a `url` part; alternative text travels in `metadata.text`.
 * - `document` with a JSON media type (`application/json` or `*+json`) and
 *   base64 bytes that parse as JSON becomes a `data` part. Any other base64
 *   document becomes a `raw` part and a referenced document a `url` part.
 * - Reasoning, server-tool, and container content has no A2A representation
 *   and throws an `A2AMappingError` naming the part kind.
 */
export function toA2APart(content: MultiModalContent): A2APart {
  switch (content.type) {
    case 'text':
      return toA2ATextPart(content);
    case 'image':
      return toA2AImagePart(content);
    case 'document':
      return toA2ADocumentPart(content);
    case 'thinking':
    case 'redacted_thinking':
      throw unsupportedA2AContent(content.type, 'A2A parts carry no model reasoning.');
    case 'server_tool_use':
    case 'web_search_tool_result':
    case 'code_execution_tool_result':
    case 'bash_code_execution_tool_result':
    case 'text_editor_code_execution_tool_result':
    case 'web_fetch_tool_result':
    case 'container_upload':
      throw unsupportedA2AContent(
        content.type,
        'provider server-tool content has no A2A part representation.',
      );
    default:
      return unreachableContent(content);
  }
}

/**
 * Converts content to A2A parts. A string becomes a single `text` part.
 */
export function toA2AParts(content: string | ReadonlyArray<MultiModalContent>): A2APart[] {
  if (typeof content === 'string') return [{ text: content }];
  return content.map(toA2APart);
}

/**
 * Converts an A2A `Part` to Conversationalist content; the inverse of
 * {@link toA2APart}.
 *
 * - `text` becomes `text` content, restoring `metadata.citations`.
 * - An unnamed `raw` or `url` part with an `image/*` media type becomes
 *   `image` content (a `raw` image as a base64 data URL), restoring
 *   `metadata.text`. Every other `raw` or `url` part becomes `document`
 *   content, so its filename survives.
 * - `data` becomes an `application/json` document holding the base64 UTF-8
 *   encoding of the serialized value.
 *
 * A file part without a media type becomes a document of type
 * `application/octet-stream`. Part metadata other than `citations` (text) and
 * `text` (image alternative text) has no place on content and is not carried.
 *
 * An absent filename maps to the empty document name and back, matching the
 * proto3 default for `string filename`. A part that sets zero or several
 * `content` oneof members throws an `A2AMappingError` of kind `part`.
 */
export function fromA2APart(part: A2APart): MultiModalContent {
  assertSingleContentMember(part);
  if (part.text !== undefined) return fromA2ATextPart(part.text, part.metadata);
  if (part.data !== undefined) return fromA2ADataPart(part);
  return fromA2AFilePart(part);
}

function toA2ATextPart(content: TextContent): A2APart {
  return {
    text: content.text,
    ...(content.citations !== undefined
      ? { metadata: { citations: toJSONValue(content.citations) } }
      : {}),
  };
}

function fromA2ATextPart(text: string, metadata: A2AStruct | undefined): TextContent {
  const citations = metadata?.['citations'];
  return {
    type: 'text',
    text,
    ...(citations !== undefined ? { citations: toJSONValue(citations) } : {}),
  };
}

function toA2AImagePart(content: ImageContent): A2APart {
  const metadata = content.text !== undefined ? { metadata: { text: content.text } } : {};
  const match = DATA_URL_PATTERN.exec(content.url);
  if (match?.[1] !== undefined && match[2] !== undefined) {
    return { raw: match[2], mediaType: match[1], ...metadata };
  }
  return {
    url: content.url,
    ...(content.mimeType !== undefined ? { mediaType: content.mimeType } : {}),
    ...metadata,
  };
}

function toA2ADocumentPart(content: DocumentContent): A2APart {
  const filename = content.name === '' ? {} : { filename: content.name };
  if (content.source.kind === 'reference') {
    return { url: content.source.uri, ...filename, mediaType: content.mimeType };
  }
  const data = isJSONMediaType(content.mimeType) ? decodeJSON(content.source.data) : undefined;
  if (data !== undefined) {
    return {
      data,
      ...filename,
      ...(content.mimeType === JSON_MEDIA_TYPE ? {} : { mediaType: content.mimeType }),
    };
  }
  return { raw: content.source.data, ...filename, mediaType: content.mimeType };
}

function fromA2ADataPart(part: A2ADataPart): DocumentContent {
  return {
    type: 'document',
    name: part.filename ?? '',
    mimeType: nonEmpty(part.mediaType) ?? JSON_MEDIA_TYPE,
    source: { kind: 'base64', data: encodeUtf8Base64(JSON.stringify(part.data)) },
  };
}

function fromA2AFilePart(part: A2ARawPart | A2AUrlPart): ImageContent | DocumentContent {
  const mediaType = nonEmpty(part.mediaType);
  if (mediaType?.startsWith('image/') === true && nonEmpty(part.filename) === undefined) {
    const text = part.metadata?.['text'];
    return {
      type: 'image',
      url: part.raw === undefined ? part.url : `data:${mediaType};base64,${part.raw}`,
      mimeType: mediaType,
      ...(typeof text === 'string' ? { text } : {}),
    };
  }
  return {
    type: 'document',
    name: part.filename ?? '',
    mimeType: mediaType ?? OCTET_STREAM_MEDIA_TYPE,
    source:
      part.raw === undefined
        ? { kind: 'reference', uri: part.url }
        : { kind: 'base64', data: part.raw },
  };
}

function assertSingleContentMember(part: A2APart): void {
  const members = (['text', 'raw', 'url', 'data'] as const).filter(
    (member) => part[member] !== undefined,
  );
  if (members.length === 1) return;
  throw new A2AMappingError(
    'error:validation',
    'part',
    `An A2A part must set exactly one of text, raw, url, or data; found ${members.length === 0 ? 'none' : members.join(', ')}.`,
    { members },
  );
}

function isJSONMediaType(mediaType: string): boolean {
  return mediaType === JSON_MEDIA_TYPE || mediaType.endsWith('+json');
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

function encodeUtf8Base64(text: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeJSON(base64: string): JSONValue | undefined {
  try {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    return parseJSONValue(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

function unreachableContent(content: never): never {
  const kind = (content as { type?: unknown }).type;
  throw unsupportedA2AContent(String(kind), 'unknown content part kind.');
}

/** Deep-copies a `google.protobuf.Struct` value so mapped messages share no JSON. */
export function copyA2AStruct(struct: A2AStruct): A2AStruct {
  return Object.fromEntries(
    Object.entries(struct).map(([key, value]) => [key, toJSONValue(value)]),
  );
}
