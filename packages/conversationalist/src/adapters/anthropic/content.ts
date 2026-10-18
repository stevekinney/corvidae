import { baseMimeType } from '../../media-types';
import { isMediaContent, type MediaContent, type MultiModalContent } from '../../multi-modal';
import { isStreamingMessage } from '../../streaming';
import type { Message, ToolCall, ToolResult } from '../../types';
import {
  createMediaExportContext,
  effectiveSource,
  recordLineage,
  rejectPart,
  toBase64Payload,
  type MediaExportContext,
} from '../media';
import type {
  AnthropicContentBlock,
  AnthropicSystemBlock,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
} from './types';

/**
 * Converts internal multi-modal content to Anthropic content blocks. Media is
 * delivered in a user message only; a media part in any other role is rejected.
 */
export function toAnthropicContent(
  content: string | ReadonlyArray<MultiModalContent>,
  context: MediaExportContext,
): string | AnthropicContentBlock[] {
  if (typeof content === 'string') return content;
  const blocks: AnthropicContentBlock[] = [];
  content.forEach((part, partIndex) => {
    const block = toAnthropicPart(part, partIndex, context);
    if (block !== undefined) blocks.push(block);
  });
  const only = blocks.length === 1 ? blocks[0] : undefined;
  return only?.type === 'text' && only.citations === undefined ? only.text : blocks;
}

function toAnthropicPart(
  part: MultiModalContent,
  partIndex: number,
  context: MediaExportContext,
): AnthropicContentBlock | undefined {
  if (!isMediaContent(part)) return toAnthropicSimplePart(part);
  if (context.role !== 'user') return rejectPart(context, partIndex, part, 'role-not-accepted');
  return toAnthropicMedia(part, partIndex, context);
}

/** The source shapes an Anthropic image and document block share. */
type SharedMediaSource =
  | { type: 'base64'; media_type: string; data: string }
  | { type: 'url'; url: string }
  | { type: 'file'; file_id: string };

function toAnthropicMedia(
  part: MediaContent,
  partIndex: number,
  context: MediaExportContext,
): AnthropicContentBlock {
  if (part.type !== 'image' && part.type !== 'document') {
    // The Messages API has no audio, video, or generic file input.
    return rejectPart(context, partIndex, part, 'modality-not-accepted', part.source.kind);
  }
  const effective = effectiveSource(context, partIndex, part);
  const { source } = effective;
  const title = part.type === 'document' && part.name !== undefined ? { title: part.name } : {};
  const wrap = (wire: SharedMediaSource): AnthropicContentBlock =>
    part.type === 'image'
      ? { type: 'image', source: wire }
      : { type: 'document', ...title, source: wire };

  if (source.kind === 'remote-url') {
    recordLineage(context, partIndex, part, effective, {
      to: 'remote-url',
      transform: 'remote-url-delegated',
    });
    return wrap({ type: 'url', url: source.url });
  }
  if (source.kind === 'provider-file') {
    if (source.provider !== 'anthropic') {
      return rejectPart(context, partIndex, part, 'source-form-not-accepted', source.kind);
    }
    recordLineage(context, partIndex, part, effective, {
      to: 'provider-file',
      transform: 'provider-file-reference',
      providerFileId: source.providerFileId,
    });
    return wrap({ type: 'file', file_id: source.providerFileId });
  }
  if (source.kind === 'inline' && source.encoding === 'utf8' && part.type === 'document') {
    // Anthropic takes plain-text documents natively; no base64 round trip. A
    // text document source's `media_type` is always "text/plain"
    // (https://platform.claude.com/docs/en/api/messages/create, PlainTextSource,
    // checked 2026-10-17), so the part's own type, if different, goes in lineage.
    recordLineage(context, partIndex, part, effective, {
      to: 'inline',
      transform: 'passthrough',
      ...(effective.mimeType !== undefined && baseMimeType(effective.mimeType) !== 'text/plain'
        ? { originalMimeType: effective.mimeType }
        : {}),
    });
    return {
      type: 'document',
      ...title,
      source: { type: 'text', media_type: 'text/plain', data: source.data },
    };
  }
  const payload = toBase64Payload(source);
  if (payload === undefined || (source.kind === 'inline' && source.encoding === 'utf8')) {
    return rejectPart(context, partIndex, part, 'source-form-not-accepted', source.kind);
  }
  const declaredMimeType = payload.mimeType ?? effective.mimeType;
  if (declaredMimeType === undefined) {
    return rejectPart(context, partIndex, part, 'mime-type-required', source.kind);
  }
  // The wire carries the base type; a parameter (`;version=1.7`) is not a type.
  const mimeType = baseMimeType(declaredMimeType);
  if (part.type === 'document' && mimeType.startsWith('text/')) {
    // A base64 document source accepts only application/pdf. Text bytes go as a
    // text source, so a text document that arrived as base64 or a data URL is
    // decoded here, or rejected before the client call when it is not UTF-8.
    const text = decodeUtf8Base64(payload.data);
    if (text === undefined) {
      return rejectPart(context, partIndex, part, 'source-form-not-accepted', source.kind);
    }
    recordLineage(context, partIndex, part, effective, {
      to: 'inline',
      transform: payload.kind === 'data-url' ? 'data-url-split' : 'inline-base64',
      ...(declaredMimeType !== 'text/plain' ? { originalMimeType: declaredMimeType } : {}),
    });
    return {
      type: 'document',
      ...title,
      source: { type: 'text', media_type: 'text/plain', data: text },
    };
  }
  recordLineage(context, partIndex, part, effective, {
    to: 'inline',
    transform: payload.kind === 'data-url' ? 'data-url-split' : 'inline-base64',
  });
  return wrap({ type: 'base64', media_type: mimeType, data: payload.data });
}

function decodeUtf8Base64(data: string): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(atob(data), (character) => character.charCodeAt(0)),
    );
  } catch {
    return undefined;
  }
}

function toAnthropicSimplePart(part: MultiModalContent): AnthropicContentBlock | undefined {
  if (part.type === 'text')
    return {
      type: 'text',
      text: part.text ?? '',
      ...(part.citations !== undefined ? { citations: part.citations } : {}),
    };
  if (part.type === 'thinking')
    return { type: 'thinking', thinking: part.thinking, signature: part.signature };
  if (part.type === 'redacted_thinking') return { type: 'redacted_thinking', data: part.data };
  if (part.type === 'server_tool_use')
    return { type: 'server_tool_use', id: part.id, name: part.name, input: part.input };
  if (part.type === 'web_search_tool_result')
    return { type: 'web_search_tool_result', tool_use_id: part.tool_use_id, content: part.content };
  if (isAnthropicMiscPart(part)) return toAnthropicMiscPart(part);
  return undefined;
}

function isAnthropicMiscPart(part: MultiModalContent): part is Extract<
  MultiModalContent,
  {
    type:
      | 'container_upload'
      | 'code_execution_tool_result'
      | 'bash_code_execution_tool_result'
      | 'text_editor_code_execution_tool_result'
      | 'web_fetch_tool_result';
  }
> {
  switch (part.type) {
    case 'container_upload':
    case 'code_execution_tool_result':
    case 'bash_code_execution_tool_result':
    case 'text_editor_code_execution_tool_result':
    case 'web_fetch_tool_result':
      return true;
    default:
      return false;
  }
}

function toAnthropicMiscPart(part: MultiModalContent): AnthropicContentBlock {
  if (part.type === 'container_upload') return { type: 'container_upload', file_id: part.file_id };
  return toAnthropicCodeBlock(part);
}

function toAnthropicCodeBlock(part: MultiModalContent): AnthropicContentBlock {
  if (part.type === 'code_execution_tool_result')
    return { type: part.type, tool_use_id: part.tool_use_id, content: part.content };
  if (part.type === 'bash_code_execution_tool_result')
    return { type: part.type, tool_use_id: part.tool_use_id, content: part.content };
  if (part.type === 'text_editor_code_execution_tool_result')
    return { type: part.type, tool_use_id: part.tool_use_id, content: part.content };
  if (part.type === 'web_fetch_tool_result') {
    return { type: part.type, tool_use_id: part.tool_use_id, content: part.content };
  }
  throw new TypeError(`Unsupported Anthropic miscellaneous content ${part.type}.`);
}

/**
 * Converts an internal ToolCall to Anthropic tool_use block.
 */
export function toToolUseBlock(toolCall: ToolCall): AnthropicToolUseBlock {
  let input: unknown = toolCall.arguments;
  if (typeof toolCall.arguments === 'string') {
    try {
      input = JSON.parse(toolCall.arguments) as unknown;
    } catch {
      input = toolCall.arguments;
    }
  }
  return {
    type: 'tool_use',
    id: toolCall.id,
    name: toolCall.name,
    input,
  };
}

/**
 * Converts an internal ToolResult to Anthropic tool_result block.
 */
export function toToolResultBlock(toolResult: ToolResult): AnthropicToolResultBlock {
  const payload =
    toolResult.outcome === 'success'
      ? toolResult.content
      : {
          outcome: toolResult.outcome,
          content: toolResult.content,
          ...(toolResult.error ? { error: toolResult.error } : {}),
          ...(toolResult.action ? { action: toolResult.action } : {}),
        };
  const result: AnthropicToolResultBlock = {
    type: 'tool_result',
    tool_use_id: toolResult.callId,
    content: typeof payload === 'string' ? payload : JSON.stringify(payload),
  };

  if (toolResult.outcome !== 'success') {
    result.is_error = true;
  }

  return result;
}

/**
 * Renders a single system/developer message's content to plain text.
 */
function systemMessageText(message: Message): string {
  if (typeof message.content === 'string') {
    return message.content;
  }
  const context = createMediaExportContext('anthropic', message, [], undefined);
  message.content.forEach((part, partIndex) => {
    if (isMediaContent(part)) rejectPart(context, partIndex, part, 'role-not-accepted');
  });
  return message.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n\n');
}

/**
 * Collects system message content from a conversation. Returns a plain
 * joined string in the common case; when at least one system message carries
 * a `cacheBoundary`, returns one addressable block per system message so the
 * cache breakpoint can be attached to the right segment.
 */
export function extractSystemPrompt(
  messages: ReadonlyArray<Message>,
  extendedCacheTtl: boolean,
): string | AnthropicSystemBlock[] | undefined {
  const systemMessages = messages.filter(
    (m) => (m.role === 'system' || m.role === 'developer') && !m.hidden && !isStreamingMessage(m),
  );

  if (systemMessages.length === 0) {
    return undefined;
  }

  const hasCacheBoundary = systemMessages.some((m) => m.cacheBoundary);
  if (!hasCacheBoundary) {
    return systemMessages.map((m) => systemMessageText(m)).join('\n\n');
  }

  return systemMessages.map((m) => {
    const text = systemMessageText(m);
    // Anthropic cannot cache an empty text block — there is nothing to cache.
    const canCache = m.cacheBoundary && text !== '';
    return {
      type: 'text' as const,
      text,
      ...(canCache
        ? {
            cache_control: {
              type: 'ephemeral' as const,
              ...(extendedCacheTtl ? { ttl: '1h' as const } : {}),
            },
          }
        : {}),
    };
  });
}
