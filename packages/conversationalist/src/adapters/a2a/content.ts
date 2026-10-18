import type { MediaContent, MultiModalContent, TextContent } from '../../multi-modal';
import type { JSONValue } from '../../types';
import {
  createMediaPart,
  encodeUtf8Base64,
  inlineBase64Source,
  parseDataUrl,
  sourceFromUrl,
} from '../media';
import { parseJSONValue, toJSONValue } from '../shared';
import { A2AMappingError, unsupportedA2AContent } from './errors';
import type { A2ADataPart, A2APart, A2ARawPart, A2AStruct, A2AUrlPart } from './proto-types';

/** Media type assumed for a `data` part that declares none. */
const JSON_MEDIA_TYPE = 'application/json';

/**
 * Converts one Conversationalist content part to an A2A `Part`.
 *
 * - `text` becomes a `text` part; citations travel in `metadata.citations`.
 * - `image` becomes a `raw` part when its URL is a base64 data URL, otherwise
 *   a `url` part; alternative text travels in `metadata.text`.
 * - A base64 `document` whose bytes are UTF-8 JSON in the exact compact form
 *   `JSON.stringify` produces becomes a `data` part, whatever its media type,
 *   because re-serializing the value reproduces those bytes exactly. Every
 *   other base64 document becomes a `raw` part with its bytes untouched, so
 *   pretty-printed JSON or JSON whose numbers exceed double precision is never
 *   rewritten. A referenced document becomes a `url` part.
 * - Reasoning, server-tool, and container content has no A2A representation
 *   and throws an `A2AMappingError` naming the part kind.
 */
export function toA2APart(content: MultiModalContent): A2APart {
  switch (content.type) {
    case 'text':
      return toA2ATextPart(content);
    case 'image':
    case 'audio':
    case 'video':
    case 'document':
    case 'file':
      return toA2AMediaPart(content);
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
 * - A `raw` or `url` part with an `image/*`, `audio/*`, or `video/*` media type
 *   becomes `image`, `audio`, or `video` content (a `raw` part as inline
 *   base64), whether or not it has a filename, which becomes the part's `name`.
 *   Every other `raw` or `url` part becomes `document` content. Part metadata
 *   restores `alt` (from `text`), `caption`, `transcript`, and `extractedText`.
 * - `data` becomes a document holding the base64 UTF-8 encoding of
 *   `JSON.stringify(data)`, typed with the part's media type or
 *   `application/json` when it declares none.
 *
 * Conversationalist content has fewer fields than an A2A part, so some
 * mappings normalize rather than round-trip exactly:
 *
 * - A file part without a media type becomes an unnamed-type document with no
 *   `mimeType`; an image with no `mimeType` and a non-data URL therefore comes
 *   back as such a document.
 * - A document with an `image/*`, `audio/*`, or `video/*` media type comes back
 *   as that modality.
 * - A data part whose media type is exactly `application/json` comes back
 *   without it, because `DocumentContent.mimeType` is required and that is the
 *   default the data part implies.
 * - A `raw` file whose bytes are already compact JSON comes back as a `data`
 *   part holding the same bytes.
 * - A file or data part whose filename is exactly `document` comes back with
 *   no filename.
 * - A text part's media type, and part metadata other than `citations` (text)
 *   and `text` (image alternative text), have no place on content and are not
 *   carried.
 *
 * An absent or empty filename (the proto3 default for `string filename`) maps
 * to the document name `document` and back. A part that sets zero or several
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

/** The part metadata keys the A2A mapping owns; `alt` keeps its historic `text` key. */
function toA2AMetadata(content: MediaContent): { metadata?: Record<string, JSONValue> } {
  const metadata: Record<string, JSONValue> = {
    ...(content.alt !== undefined ? { text: content.alt } : {}),
    ...(content.caption !== undefined ? { caption: content.caption } : {}),
    ...(content.transcript !== undefined ? { transcript: content.transcript } : {}),
    ...(content.extractedText !== undefined ? { extractedText: content.extractedText } : {}),
    ...(content.metadata !== undefined ? { metadata: toJSONValue(content.metadata) } : {}),
  };
  return Object.keys(metadata).length > 0 ? { metadata } : {};
}

function toA2AMediaPart(content: MediaContent): A2APart {
  const { source } = content;
  const metadata = toA2AMetadata(content);
  const filename =
    content.name === undefined || content.name === '' ? {} : { filename: content.name };
  if (source.kind === 'remote-url') {
    return {
      url: source.url,
      ...filename,
      ...(content.mimeType !== undefined ? { mediaType: content.mimeType } : {}),
      ...metadata,
    };
  }
  if (source.kind !== 'inline' && source.kind !== 'data-url') {
    throw unsupportedA2AContent(
      content.type,
      `a ${source.kind} source has no A2A part representation.`,
    );
  }
  const bytes =
    source.kind === 'inline'
      ? { data: source.encoding === 'base64' ? source.data : encodeUtf8Base64(source.data) }
      : parseDataUrl(source.url);
  if (bytes === undefined) {
    throw unsupportedA2AContent(content.type, 'its data URL carries no bytes.');
  }
  const mediaType = content.mimeType ?? ('mimeType' in bytes ? bytes.mimeType : undefined);
  const json =
    mediaType !== undefined && content.type === 'document'
      ? decodeCanonicalJSON(bytes.data)
      : undefined;
  if (mediaType !== undefined && json !== undefined) {
    return {
      data: json.value,
      ...filename,
      ...(mediaType === JSON_MEDIA_TYPE ? {} : { mediaType }),
      ...metadata,
    };
  }
  return {
    raw: bytes.data,
    ...filename,
    ...(mediaType !== undefined ? { mediaType } : {}),
    ...metadata,
  };
}

function fromA2AMetadata(metadata: A2AStruct | undefined) {
  const text = metadata?.['text'];
  const caption = metadata?.['caption'];
  const transcript = metadata?.['transcript'];
  const extractedText = metadata?.['extractedText'];
  const nested = metadata?.['metadata'];
  return {
    ...(typeof text === 'string' ? { alt: text } : {}),
    ...(typeof caption === 'string' ? { caption } : {}),
    ...(typeof transcript === 'string' ? { transcript } : {}),
    ...(typeof extractedText === 'string' ? { extractedText } : {}),
    ...(typeof nested === 'object' && nested !== null && !Array.isArray(nested)
      ? { metadata: toJSONRecord(nested) }
      : {}),
  };
}

function toJSONRecord(value: object): Record<string, JSONValue> {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, toJSONValue(entry)]));
}

function fromA2ADataPart(part: A2ADataPart): MediaContent {
  const name = nonEmpty(part.filename);
  return {
    ...createMediaPart(
      'document',
      inlineBase64Source(encodeUtf8Base64(JSON.stringify(part.data))),
      { mimeType: nonEmpty(part.mediaType) ?? JSON_MEDIA_TYPE, name },
    ),
    ...fromA2AMetadata(part.metadata),
  };
}

function fromA2AFilePart(part: A2ARawPart | A2AUrlPart): MediaContent {
  const mediaType = nonEmpty(part.mediaType);
  const name = nonEmpty(part.filename);
  const family = mediaType?.split('/')[0];
  // The media type decides the modality; a filename never changes it.
  const modality =
    family === 'image' || family === 'audio' || family === 'video' ? family : 'document';
  return {
    ...createMediaPart(
      modality,
      part.raw === undefined
        ? sourceFromUrl(part.url, (url) =>
            unsupportedA2AContent('part', `its URL "${url}" is not an http, https, or data URL.`),
          )
        : inlineBase64Source(part.raw),
      { mimeType: mediaType, name },
    ),
    ...fromA2AMetadata(part.metadata),
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

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/**
 * Decodes base64 bytes as a JSON value only when `JSON.stringify` of that value
 * reproduces the decoded text exactly, so mapping the value to a `data` part
 * loses no byte of the original file.
 */
function decodeCanonicalJSON(base64: string): { value: JSONValue } | undefined {
  let text: string;
  try {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  const value = parseJSONValue(text);
  return value !== undefined && JSON.stringify(value) === text ? { value } : undefined;
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
