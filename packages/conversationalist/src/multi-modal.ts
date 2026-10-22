import type {
  ContentSource,
  MediaContent,
  Modality,
  TextContent,
  ToolResultPart,
} from 'armorer/protocol';

import type { JSONValue } from './types';

// The portable part vocabulary (text, media, and `ContentSource`) is defined in
// `armorer/protocol`, so a tool result can carry the same parts.
export type {
  AudioContent,
  ContentSource,
  DocumentContent,
  FileContent,
  ImageContent,
  MediaContent,
  MediaContentFields,
  Modality,
  TextContent,
  ToolResultPart,
  VideoContent,
} from 'armorer/protocol';

/**
 * Renders a short human-readable placeholder for a media part. Display only:
 * no provider or compaction path may use this in place of the part itself.
 */
export function renderMediaPlaceholder(part: MediaContent): string {
  const label = part.name ?? part.alt ?? part.type;
  const mime = part.mimeType === undefined ? '' : ` (${part.mimeType})`;
  const capitalized = part.type.charAt(0).toUpperCase() + part.type.slice(1);
  return `[${capitalized}: ${label}${mime}${describeSourceLocation(part.source)}]`;
}

function describeSourceLocation(source: ContentSource): string {
  switch (source.kind) {
    case 'remote-url':
      return ` at ${source.url}`;
    case 'local-file':
      return ` at ${source.path}`;
    case 'inline':
      return source.encoding === 'base64' ? '; base64 data omitted' : '; inline text omitted';
    case 'data-url':
      return '; base64 data omitted';
    case 'managed-asset':
      return `; managed asset ${source.assetId}`;
    case 'provider-file':
      return `; ${source.provider} file ${source.providerFileId}`;
    case 'upload':
      return `; upload ${source.uploadId}`;
    case 'mcp-resource':
      return ` at ${source.uri}`;
    case 'a2a-reference':
      return `; A2A artifact ${source.artifactId}`;
  }
}

/**
 * The URL a UI may display for a source: defined for `data-url` and
 * `remote-url`, `undefined` for every other kind.
 */
export function contentSourceDisplayUrl(source: ContentSource): string | undefined {
  return source.kind === 'data-url' || source.kind === 'remote-url' ? source.url : undefined;
}

/**
 * The URL a UI may load a media part from: its {@link contentSourceDisplayUrl}
 * or, for inline base64 bytes with a declared media type, the equivalent data
 * URL. `undefined` when the part carries no address a browser can load.
 */
export function mediaDisplayUrl(part: MediaContent): string | undefined {
  const url = contentSourceDisplayUrl(part.source);
  if (url !== undefined) return url;
  const { source } = part;
  return source.kind === 'inline' && source.encoding === 'base64' && part.mimeType !== undefined
    ? `data:${part.mimeType};base64,${source.data}`
    : undefined;
}

/** Whether a content part is a media part (image, audio, video, document, or file). */
export function isMediaContent(part: MultiModalContent): part is MediaContent {
  return (
    part.type === 'image' ||
    part.type === 'audio' ||
    part.type === 'video' ||
    part.type === 'document' ||
    part.type === 'file'
  );
}

/**
 * Extended thinking content block.
 * Represents the model's internal reasoning. The signature must be preserved
 * byte-for-byte for subsequent conversation turns.
 */
export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
  signature: string;
}

/**
 * Redacted extended thinking content block.
 * The plaintext reasoning is withheld; Anthropic returns its encrypted payload in
 * a `data` field (NOT a `signature`). The `data` must be preserved byte-for-byte
 * and replayed unchanged on subsequent conversation turns.
 */
export interface RedactedThinkingContent {
  type: 'redacted_thinking';
  data: string;
}

/**
 * Server-side tool use content block (e.g. Anthropic built-in tools such as web_search).
 * Input is the JSON the model produced for the built-in tool.
 *
 * Note: there is intentionally NO client-tool-use content block. A client tool
 * call is represented as a `tool-call` ROLE message (so a later `tool-result`
 * can pair to it), not as assistant content — putting a client tool call in
 * content would create an orphaned tool result that integrity rejects.
 */
export interface ServerToolUseContent {
  type: 'server_tool_use';
  id: string;
  name: string;
  input: JSONValue;
}

/**
 * Web search tool result content block returned by Anthropic's built-in web_search tool.
 */
export interface WebSearchToolResultContent {
  type: 'web_search_tool_result';
  tool_use_id: string;
  content: JSONValue;
}

/**
 * Result block types for Anthropic's built-in server tools (code execution and
 * web fetch). Enumerated explicitly (rather than an open string) so they
 * discriminate cleanly; add a literal here when Anthropic ships a new
 * server-tool result block.
 */
export type ServerToolResultType =
  | 'code_execution_tool_result'
  | 'bash_code_execution_tool_result'
  | 'text_editor_code_execution_tool_result'
  | 'web_fetch_tool_result';

/**
 * Result block returned by an Anthropic built-in server tool (code execution,
 * web fetch). Preserves stdout, exit codes, file ids, fetched content, and
 * errors so they round-trip in the conversation history instead of being dropped.
 */
export interface ServerToolResultContent {
  type: ServerToolResultType;
  tool_use_id: string;
  content: JSONValue;
}

/**
 * Container upload content block. Anthropic represents a file uploaded into a
 * code-execution container as a `container_upload` block referencing the
 * uploaded file by id; preserved so the reference survives the round-trip.
 */
export interface ContainerUploadContent {
  type: 'container_upload';
  file_id: string;
}

export type MultiModalContent =
  | TextContent
  | MediaContent
  | ThinkingContent
  | RedactedThinkingContent
  | ServerToolUseContent
  | WebSearchToolResultContent
  | ServerToolResultContent
  | ContainerUploadContent;

/**
 * Creates a shallow copy of a MultiModalContent item.
 */
export function copyMultiModalContent(item: MultiModalContent): MultiModalContent {
  if (item.type === 'text') {
    return {
      type: 'text',
      text: item.text,
      ...(item.citations !== undefined ? { citations: structuredClone(item.citations) } : {}),
    };
  }
  if (item.type === 'thinking') {
    return {
      type: 'thinking',
      thinking: item.thinking,
      signature: item.signature,
    };
  }
  if (item.type === 'redacted_thinking') {
    return {
      type: 'redacted_thinking',
      data: item.data,
    };
  }
  if (item.type === 'server_tool_use') {
    return {
      type: 'server_tool_use',
      // Deep-copy the JSON payload: copyContent feeds messageToJSON and clone
      // paths that must return independent values, so a shared object/array
      // reference would let a mutation of the copy leak into the original.
      id: item.id,
      name: item.name,
      input: structuredClone(item.input),
    };
  }
  if ('tool_use_id' in item) {
    return {
      type: item.type,
      tool_use_id: item.tool_use_id,
      content: structuredClone(item.content),
    };
  }
  if (item.type === 'container_upload') {
    return { type: 'container_upload', file_id: item.file_id };
  }
  return copyMediaContent(item);
}

function copyMediaContent(part: MediaContent): MediaContent {
  const { metadata, source, ...rest } = part;
  return {
    ...rest,
    source: { ...source },
    ...(metadata !== undefined ? { metadata: structuredClone(metadata) } : {}),
  };
}

/**
 * Every media part a message carries, with where it sits: its own content, then, for a
 * tool-result row, its result's `parts`. A row's two lists never both hold media (a tool-result
 * row's content is empty), so `partIndex` is unique within the message and keys a resolved source
 * the way the provider adapters read it. Anything that looks for a message's media (compaction,
 * redaction, asset claims, media admission) reads it here, so no payload is missed.
 */
export function messageMediaParts(message: {
  readonly content: string | ReadonlyArray<MultiModalContent>;
  readonly toolResult?: { readonly parts?: ReadonlyArray<ToolResultPart> | undefined } | undefined;
}): Array<{ part: MediaContent; partIndex: number; inToolResult: boolean }> {
  const found: Array<{ part: MediaContent; partIndex: number; inToolResult: boolean }> = [];
  if (typeof message.content !== 'string') {
    message.content.forEach((part, partIndex) => {
      if (isMediaContent(part)) found.push({ part, partIndex, inToolResult: false });
    });
  }
  message.toolResult?.parts?.forEach((part, partIndex) => {
    if (part.type !== 'text') found.push({ part, partIndex, inToolResult: true });
  });
  return found;
}

/** Copies one tool-result part, as {@link copyMultiModalContent} copies any part. */
export function copyToolResultPart(part: ToolResultPart): ToolResultPart {
  return part.type === 'text'
    ? (copyMultiModalContent(part) as TextContent)
    : copyMediaContent(part);
}

/**
 * Copies content, ensuring a mutable array is returned for multi-modal content.
 */
export function copyContent(
  content: string | ReadonlyArray<MultiModalContent>,
): string | MultiModalContent[] {
  if (typeof content === 'string') {
    return content;
  }
  return content.map(copyMultiModalContent);
}

// ── AB-70 portable content and modality vocabulary ──────────────────────
//
// Transcribed verbatim from AB-70's "Portable content and modality
// vocabulary" section (ratified 2026-09-01). `MediaContentFields.source` above
// is this `ContentSource`: one persisted representation of a media part's
// bytes or location. See `multi-modal-vocabulary.test-d.ts` for the
// compile-time shape proof.

// A MIME "family" is the type before the slash, plus the handful of container
// formats that need their own bucket because they carry mixed content.
export type MimeFamily =
  | 'text'
  | 'image'
  | 'audio'
  | 'video'
  | 'document' // application/pdf and other paginated/structured document containers
  | 'application' // generic binary / octet-stream and non-document application/* types
  | 'font'
  | 'model'; // 3D/model/* MIME types, carried as generic `file` parts

export type MediaLimitScope = 'per-part' | 'aggregate';

export interface MediaLimits {
  scope: MediaLimitScope;
  modality: Modality;
  maxBytes?: number;
  maxDurationSeconds?: number; // audio/video
  maxPixels?: number; // image/video, guards decompression/pixel-bomb inputs
  maxPageCount?: number; // document
}

/**
 * Capability discovery: each provider adapter and Gateway-advertised
 * protocol exposes a `ModalityMatrix`, consumed by AB-64's backend
 * descriptor (`BackendDescriptor.modalities`).
 */
export type ModalityMatrix = Record<
  Modality,
  { input: boolean; output: boolean; sourceForms: readonly ContentSource['kind'][] }
>;

/** How a media part's source reached the provider wire format. */
export type ContentTransform =
  | 'passthrough' // the provider accepts this source kind natively; sent as-is
  | 'data-url-split' // data-url → provider base64 block plus media type
  | 'inline-base64' // inline bytes → provider base64 block
  | 'remote-url-delegated' // the provider fetches the URL itself
  | 'provider-file-reference' // provider-file id referenced on the wire
  | 'resolved'; // operative replaced the source before export

/**
 * One entry per media part an adapter delivered: what the part was, what the
 * provider received, and how it got there. A side channel on each adapter's
 * export result; message content is never rewritten to record it.
 */
export interface ContentPartLineage {
  readonly messageId: string;
  readonly partIndex: number;
  readonly modality: Modality;
  readonly provider: 'openai' | 'anthropic' | 'gemini';
  readonly from: ContentSource['kind'];
  readonly to: ContentSource['kind'];
  readonly transform: ContentTransform;
  readonly providerFileId?: string | undefined;
  /** The part's own media type, recorded when the wire carried a different one. */
  readonly originalMimeType?: string | undefined;
  readonly assetId?: string | undefined;
  readonly revision?: number | undefined;
}
