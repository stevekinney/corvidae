import type { JSONValue } from './types';

// ── Portable content parts ──────────────────────────────────────────────
//
// AB-70's portable content vocabulary. It lives here, beside `ToolResult`,
// so a tool result can carry ordered parts without Armorer importing
// Conversationalist; Conversationalist re-exports every name unchanged.

/** A text part. */
export interface TextContent {
  type: 'text';
  text: string;
  /**
   * Citation references Anthropic attaches to cited text (e.g. from web search).
   * Preserved opaquely so they round-trip for display and multi-turn replay.
   */
  citations?: JSONValue;
}

/** Fields every media part carries. `source` is a `ContentSource` (below); nothing else names bytes or a location. */
export interface MediaContentFields {
  source: ContentSource;
  mimeType?: string;
  name?: string;
  alt?: string;
  caption?: string;
  transcript?: string;
  extractedText?: string;
  metadata?: Readonly<Record<string, JSONValue>>;
}

/** An image part. */
export interface ImageContent extends MediaContentFields {
  type: 'image';
}
/** An audio part. */
export interface AudioContent extends MediaContentFields {
  type: 'audio';
}
/** A video part. */
export interface VideoContent extends MediaContentFields {
  type: 'video';
}
/** A document part (PDF and other paginated or structured documents). */
export interface DocumentContent extends MediaContentFields {
  type: 'document';
}
/** A generic file part. */
export interface FileContent extends MediaContentFields {
  type: 'file';
}

/** Any media part. */
export type MediaContent =
  ImageContent | AudioContent | VideoContent | DocumentContent | FileContent;

/** The six portable content modalities a backend or provider can carry. */
export type Modality = 'text' | 'image' | 'audio' | 'video' | 'document' | 'file';

/** The nine ingress source forms: one persisted representation of a media part's bytes or location. */
export type ContentSource =
  | { kind: 'inline'; data: string; encoding: 'base64' | 'utf8' }
  | { kind: 'data-url'; url: string }
  | { kind: 'remote-url'; url: string } // deny-by-default hardened fetch is deployment configuration
  | { kind: 'local-file'; path: string } // host-process only; never crosses a network boundary
  | { kind: 'upload'; uploadId: string } // prior to becoming a ManagedAsset
  | { kind: 'provider-file'; provider: string; providerFileId: string }
  | { kind: 'mcp-resource'; serverId: string; uri: string }
  | { kind: 'a2a-reference'; agentCardUrl: string; taskId: string; artifactId: string } // an A2A artifactId is unique only within its task
  | { kind: 'managed-asset'; assetId: string; revision?: number };

/** One ordered, model-facing part of a tool result: text or media. */
export type ToolResultPart = TextContent | MediaContent;

const MEDIA_TYPES: ReadonlySet<string> = new Set(['image', 'audio', 'video', 'document', 'file']);

const SOURCE_FIELDS: Readonly<Record<ContentSource['kind'], readonly string[]>> = {
  inline: ['data'],
  'data-url': ['url'],
  'remote-url': ['url'],
  'local-file': ['path'],
  upload: ['uploadId'],
  'provider-file': ['provider', 'providerFileId'],
  'mcp-resource': ['serverId', 'uri'],
  'a2a-reference': ['agentCardUrl', 'taskId', 'artifactId'],
  'managed-asset': ['assetId'],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sourceProblem(source: unknown): string | undefined {
  if (!isRecord(source)) return 'source must be an object';
  const kind = source['kind'];
  if (typeof kind !== 'string' || !Object.hasOwn(SOURCE_FIELDS, kind)) {
    return `source.kind ${JSON.stringify(kind)} is not a content source kind`;
  }
  for (const field of SOURCE_FIELDS[kind as ContentSource['kind']]) {
    if (typeof source[field] !== 'string') return `source.${field} must be a string`;
  }
  if (kind === 'inline' && source['encoding'] !== 'base64' && source['encoding'] !== 'utf8') {
    return 'source.encoding must be "base64" or "utf8"';
  }
  const revision = source['revision'];
  if (
    kind === 'managed-asset' &&
    revision !== undefined &&
    !(typeof revision === 'number' && Number.isInteger(revision) && revision >= 0)
  ) {
    return 'source.revision must be a non-negative integer';
  }
  return undefined;
}

function partProblem(part: unknown): string | undefined {
  if (!isRecord(part)) return 'part must be an object';
  const type = part['type'];
  if (type === 'text')
    return typeof part['text'] === 'string' ? undefined : 'text must be a string';
  if (typeof type !== 'string' || !MEDIA_TYPES.has(type)) {
    return `type ${JSON.stringify(type)} is not a tool-result part type`;
  }
  if (part['mimeType'] !== undefined && typeof part['mimeType'] !== 'string') {
    return 'mimeType must be a string';
  }
  return sourceProblem(part['source']);
}

/**
 * Checks the shape of a tool result's parts: an array of text parts and media
 * parts whose `source` names one of the nine content source kinds with its
 * required fields. MIME-type and payload checks belong to the conversation
 * schema, which validates stored parts in one place.
 */
export function assertToolResultParts(value: unknown): asserts value is ToolResultPart[] {
  if (!Array.isArray(value)) throw new TypeError('Tool result parts must be an array.');
  value.forEach((part: unknown, index) => {
    const problem = partProblem(part);
    if (problem !== undefined) {
      throw new TypeError(`Tool result part ${index} is invalid: ${problem}.`);
    }
  });
}

/** Whether a value is a valid array of tool-result parts. See {@link assertToolResultParts}. */
export function isToolResultParts(value: unknown): value is ToolResultPart[] {
  try {
    assertToolResultParts(value);
    return true;
  } catch {
    return false;
  }
}

// ── Tool content: how a tool returns parts ──────────────────────────────

/** The discriminant {@link toolContent} values carry. */
export const TOOL_CONTENT_KIND = 'armorer.tool-content';

/**
 * A tool's return value when it answers with ordered parts. Armorer turns it
 * into a result whose `parts` are these parts and whose `content` is `value`
 * (or `null`). It is plain JSON, so a cached or persisted copy is still
 * recognized after a JSON round trip.
 */
export interface ToolContent {
  readonly kind: typeof TOOL_CONTENT_KIND;
  /** The ordered, model-facing parts. */
  readonly parts: readonly ToolResultPart[];
  /** The JSON application value beside the parts, such as MCP `structuredContent`. */
  readonly value?: JSONValue;
}

/**
 * Builds the value a tool returns to answer with ordered text and media parts.
 * Throws when a part is malformed. See {@link assertToolResultParts}.
 */
export function toolContent(
  parts: readonly ToolResultPart[],
  options: { value?: JSONValue } = {},
): ToolContent {
  assertToolResultParts(parts);
  return {
    kind: TOOL_CONTENT_KIND,
    parts: [...parts],
    ...(options.value === undefined ? {} : { value: options.value }),
  };
}

/** Whether a tool's return value is a {@link ToolContent} with valid parts. */
export function isToolContent(value: unknown): value is ToolContent {
  return (
    isRecord(value) && value['kind'] === TOOL_CONTENT_KIND && isToolResultParts(value['parts'])
  );
}

// ── Redaction: what events, logs, and audit may show of a part ──────────

/**
 * A media part as events, logs, and audit records show it: its type, MIME
 * type, name, and where it lives, with no bytes and no URL or path. A managed
 * asset keeps its identity; inline bytes keep only their length.
 */
export interface RedactedMediaPart {
  readonly type: MediaContent['type'];
  readonly mimeType?: string;
  readonly name?: string;
  readonly redacted: true;
  readonly source: {
    readonly kind: ContentSource['kind'];
    readonly assetId?: string;
    readonly revision?: number;
    readonly serverId?: string;
    readonly provider?: string;
    readonly byteLength?: number;
  };
}

function base64ByteLength(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

function redactedSource(source: ContentSource): RedactedMediaPart['source'] {
  switch (source.kind) {
    case 'inline':
      return {
        kind: 'inline',
        byteLength:
          source.encoding === 'base64'
            ? base64ByteLength(source.data)
            : new TextEncoder().encode(source.data).length,
      };
    case 'managed-asset':
      return {
        kind: 'managed-asset',
        assetId: source.assetId,
        ...(source.revision === undefined ? {} : { revision: source.revision }),
      };
    case 'mcp-resource':
      return { kind: 'mcp-resource', serverId: source.serverId };
    case 'provider-file':
      return { kind: 'provider-file', provider: source.provider };
    default:
      return { kind: source.kind };
  }
}

/** A part as events, logs, and audit may show it: text unchanged, media as {@link RedactedMediaPart}. */
export function redactToolResultPart(part: ToolResultPart): TextContent | RedactedMediaPart {
  if (part.type === 'text') return part;
  return {
    type: part.type,
    ...(part.mimeType === undefined ? {} : { mimeType: part.mimeType }),
    ...(part.name === undefined ? {} : { name: part.name }),
    redacted: true,
    source: redactedSource(part.source),
  };
}

/**
 * A tool's return value as events, logs, and audit may show it: a
 * {@link ToolContent} with its media parts redacted, and any other value
 * unchanged.
 */
export function redactToolContent(value: unknown): unknown {
  if (!isToolContent(value)) return value;
  return { ...value, parts: value.parts.map(redactToolResultPart) };
}

/**
 * A tool result as events, logs, and audit may show it: its `parts`, and a
 * {@link ToolContent} raw `result`, with media redacted. A result without
 * parts is returned as it is.
 */
export function redactToolResultMedia<
  Result extends {
    readonly parts?: readonly ToolResultPart[] | undefined;
    readonly result?: unknown;
  },
>(
  result: Result,
): Result | (Omit<Result, 'parts'> & { parts?: Array<TextContent | RedactedMediaPart> }) {
  if (result.parts === undefined && !isToolContent(result.result)) return result;
  return {
    ...result,
    ...(result.parts === undefined ? {} : { parts: result.parts.map(redactToolResultPart) }),
    ...('result' in result ? { result: redactToolContent(result.result) } : {}),
  };
}
