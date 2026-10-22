import { assertConversationSafe } from '../../conversation/validation';
import { baseMimeType } from '../../media-types';
import type { ContentPartLineage, MediaContent, MultiModalContent } from '../../multi-modal';
import { isMediaContent } from '../../multi-modal';
import { isStreamingMessage } from '../../streaming';
import type {
  ConversationHistory as Conversation,
  Message,
  ToolCall,
  ToolResult,
} from '../../types';
import { getOrderedMessages } from '../../utilities/message-store';
import {
  createMediaExportContext,
  effectiveSource,
  recordLineage,
  rejectPart,
  toBase64Payload,
  type MediaExportContext,
  type MediaExportOptions,
} from '../media';
import { stringifyToolResult } from '../shared';
import type {
  OpenAIContentPart,
  OpenAIExport,
  OpenAIMessage,
  OpenAITextContentPart,
  OpenAIToolCall,
} from './types';

/**
 * Converts internal multi-modal content to OpenAI content parts format.
 * `allowMedia` is `false` for roles whose wire format carries text only; a
 * media part there is rejected, never dropped.
 */
function toOpenAIContent(
  content: string | ReadonlyArray<MultiModalContent>,
  context: MediaExportContext,
  options: { allowMedia: boolean },
): string | OpenAIContentPart[] | OpenAITextContentPart[] {
  if (typeof content === 'string') {
    return content;
  }

  const parts: OpenAIContentPart[] = [];
  content.forEach((part, partIndex) => {
    const converted = toOpenAIContentPart(part, partIndex, context, options.allowMedia);
    if (converted) {
      parts.push(converted);
    }
  });

  if (parts.length === 0) {
    return '';
  }

  if (parts.length === 1 && parts[0]?.type === 'text') {
    return parts[0].text;
  }

  return parts;
}

function toOpenAIContentPart(
  part: MultiModalContent,
  partIndex: number,
  context: MediaExportContext,
  allowMedia: boolean,
): OpenAIContentPart | undefined {
  if (part.type === 'text') return { type: 'text', text: part.text };
  if (isMediaContent(part)) {
    if (!allowMedia) return rejectPart(context, partIndex, part, 'role-not-accepted');
    return toOpenAIMediaPart(part, partIndex, context);
  }
  // `container_upload` is an upload reference, not provider-private reasoning:
  // OpenAI cannot carry it, so it is rejected rather than dropped.
  if (part.type === 'container_upload') {
    return rejectPart(context, partIndex, part, 'part-type-not-accepted');
  }
  // Thinking, server-tool, and tool-result blocks are Anthropic-private replay
  // data. They are not user input and have no OpenAI wire form; they stay out
  // of an OpenAI request by design.
  return undefined;
}

function toOpenAIMediaPart(
  part: MediaContent,
  partIndex: number,
  context: MediaExportContext,
): OpenAIContentPart {
  const effective = effectiveSource(context, partIndex, part);
  const { source } = effective;
  if (part.type === 'image') {
    if (source.kind === 'remote-url') {
      recordLineage(context, partIndex, part, effective, {
        to: 'remote-url',
        transform: 'remote-url-delegated',
      });
      return { type: 'image_url', image_url: { url: source.url } };
    }
    if (source.kind === 'data-url') {
      // A base64 data URL goes through untouched; any other encoding is rebuilt
      // as one, and lineage says so.
      const payload = toBase64Payload(source);
      const mimeType = effective.mimeType;
      if (payload === undefined || mimeType === undefined) {
        return rejectPart(context, partIndex, part, 'source-form-not-accepted', source.kind);
      }
      const rebuilt = `data:${baseMimeType(mimeType)};base64,${payload.data}`;
      const unchanged = rebuilt === source.url;
      recordLineage(context, partIndex, part, effective, {
        to: 'data-url',
        transform: unchanged ? 'passthrough' : 'data-url-split',
      });
      return { type: 'image_url', image_url: { url: unchanged ? source.url : rebuilt } };
    }
    if (source.kind === 'inline') {
      const payload = toBase64Payload(source);
      const mimeType = effective.mimeType;
      if (payload === undefined || mimeType === undefined) {
        return rejectPart(context, partIndex, part, 'mime-type-required', source.kind);
      }
      recordLineage(context, partIndex, part, effective, {
        to: 'data-url',
        transform: 'inline-base64',
      });
      return {
        type: 'image_url',
        image_url: { url: `data:${baseMimeType(mimeType)};base64,${payload.data}` },
      };
    }
    return rejectPart(context, partIndex, part, 'source-form-not-accepted', source.kind);
  }
  if (part.type === 'document') {
    // https://developers.openai.com/api/docs/guides/pdf-files (checked
    // 2026-10-17): "Chat Completions supports only .pdf (application/pdf) for
    // both file_data and file_id." A document is a `file` part holding a base64
    // data URL or a Files API id; there is no URL form on this endpoint.
    if (source.kind === 'provider-file') {
      if (source.provider !== 'openai') {
        return rejectPart(context, partIndex, part, 'source-form-not-accepted', source.kind);
      }
      recordLineage(context, partIndex, part, effective, {
        to: 'provider-file',
        transform: 'provider-file-reference',
        providerFileId: source.providerFileId,
      });
      return {
        type: 'file',
        file: {
          file_id: source.providerFileId,
          ...(part.name !== undefined ? { filename: part.name } : {}),
        },
      };
    }
    const payload = toBase64Payload(source);
    if (payload === undefined) {
      return rejectPart(context, partIndex, part, 'source-form-not-accepted', source.kind);
    }
    const mimeType = effective.mimeType;
    if (mimeType === undefined) {
      return rejectPart(context, partIndex, part, 'mime-type-required', source.kind);
    }
    if (baseMimeType(mimeType) !== 'application/pdf') {
      return rejectPart(context, partIndex, part, 'mime-family-not-accepted', source.kind);
    }
    const rebuilt = `data:${baseMimeType(mimeType)};base64,${payload.data}`;
    recordLineage(context, partIndex, part, effective, {
      to: 'data-url',
      transform:
        payload.kind === 'data-url'
          ? source.kind === 'data-url' && source.url === rebuilt
            ? 'passthrough'
            : 'data-url-split'
          : 'inline-base64',
    });
    return {
      type: 'file',
      file: {
        file_data: rebuilt,
        ...(part.name !== undefined ? { filename: part.name } : {}),
      },
    };
  }
  // Audio, video, and the generic `file` modality have no Chat Completions input.
  return rejectPart(context, partIndex, part, 'modality-not-accepted', source.kind);
}

/**
 * Converts internal multi-modal content to OpenAI text-only format.
 */
function toOpenAITextContent(
  content: string | ReadonlyArray<MultiModalContent>,
  context: MediaExportContext,
): string | OpenAITextContentPart[] {
  const converted = toOpenAIContent(content, context, { allowMedia: false });
  if (typeof converted === 'string') return converted;
  // `allowMedia: false` rejected every media part above, so only text remains.
  const parts: readonly OpenAIContentPart[] = converted;
  return parts.filter((part): part is OpenAITextContentPart => part.type === 'text');
}

/**
 * Converts an internal ToolCall to OpenAI format.
 */
function toOpenAIToolCall(toolCall: ToolCall): OpenAIToolCall {
  return {
    id: toolCall.id,
    type: 'function',
    function: {
      name: toolCall.name,
      arguments:
        typeof toolCall.arguments === 'string'
          ? toolCall.arguments
          : JSON.stringify(toolCall.arguments),
    },
  };
}

/**
 * Converts a single message to OpenAI format.
 * Returns null for messages that should be skipped.
 *
 * `message.cacheBoundary` is intentionally a no-op here: OpenAI's prompt
 * caching (Chat Completions / Responses API) is automatic — the platform
 * caches the longest matching prefix of a request with no manual breakpoint
 * marker to translate to. There is no OpenAI wire field this maps to.
 */
function convertMessage(
  message: Message,
  lineage: ContentPartLineage[],
  options: MediaExportOptions | undefined,
): OpenAIMessage | null {
  // Skip hidden messages
  if (message.hidden) {
    return null;
  }

  // Skip streaming messages (incomplete, not ready for provider export)
  if (isStreamingMessage(message)) {
    return null;
  }

  return convertMessageByRole(
    message,
    createMediaExportContext('openai', message, lineage, options),
  );
}

/**
 * A tool message's content. Chat Completions tool messages carry text only, so
 * a successful result's text parts go as ordered text parts and any media part
 * is rejected, never described in text.
 */
function toOpenAIToolResultContent(
  toolResult: ToolResult,
  context: MediaExportContext,
): string | OpenAITextContentPart[] {
  if (toolResult.outcome !== 'success' || toolResult.parts === undefined) {
    return stringifyToolResult(toolResult);
  }
  return toolResult.parts.map((part, partIndex) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : rejectPart(context, partIndex, part, 'role-not-accepted', part.source.kind),
  );
}

function convertMessageByRole(message: Message, context: MediaExportContext): OpenAIMessage | null {
  switch (message.role) {
    case 'system':
    case 'developer':
      return {
        role: 'system',
        content: toOpenAITextContent(message.content, context),
      };

    case 'user':
      return {
        role: 'user',
        content: toOpenAIContent(message.content, context, { allowMedia: true }),
      };

    case 'assistant': {
      const content = toOpenAITextContent(message.content, context);
      // An assistant row can hold only provider-private replay blocks (a thinking
      // row that precedes a tool call). OpenAI cannot carry them, and an empty
      // assistant message in front of the tool-call message is not a valid turn.
      if (content === '') return null;
      return { role: 'assistant', content };
    }

    case 'tool-call':
      if (!message.toolCall) {
        return null;
      }
      return {
        role: 'assistant',
        content: null,
        tool_calls: [toOpenAIToolCall(message.toolCall)],
      };

    case 'tool-result':
      if (!message.toolResult) {
        return null;
      }
      return {
        role: 'tool',
        content: toOpenAIToolResultContent(message.toolResult, context),
        tool_call_id: message.toolResult.callId,
      };

    case 'snapshot':
      // Snapshots are internal state, not sent to API
      return null;
    default:
      return null;
  }
}

/**
 * Converts a conversation to OpenAI Chat Completions API message format.
 * Handles role mapping, tool calls, and multi-modal content.
 *
 * @example
 * ```ts
 * import { toOpenAIMessages } from 'conversationalist';
 *
 * const messages = toOpenAIMessages(conversation);
 * const response = await openai.chat.completions.create({
 *   model: 'gpt-4',
 *   messages,
 * });
 * ```
 */
export function toOpenAIMessages(
  conversation: Conversation,
  options?: MediaExportOptions,
): OpenAIExport {
  assertConversationSafe(conversation);
  const messages: OpenAIMessage[] = [];
  const lineage: ContentPartLineage[] = [];

  for (const message of getOrderedMessages(conversation)) {
    const converted = convertMessage(message, lineage, options);
    if (converted) {
      messages.push(converted);
    }
  }

  return { messages, lineage };
}

/**
 * Groups consecutive tool-call messages into a single assistant message with multiple tool_calls.
 * This is useful when the model made multiple tool calls in sequence.
 */
export function toOpenAIMessagesGrouped(
  conversation: Conversation,
  options?: MediaExportOptions,
): OpenAIExport {
  assertConversationSafe(conversation);
  const messages: OpenAIMessage[] = [];
  const lineage: ContentPartLineage[] = [];
  let pendingToolCalls: OpenAIToolCall[] = [];

  for (const message of getOrderedMessages(conversation)) {
    if (message.hidden) continue;
    if (isStreamingMessage(message)) continue;

    if (message.role === 'tool-call' && message.toolCall) {
      pendingToolCalls.push(toOpenAIToolCall(message.toolCall));
      continue;
    }

    // Flush pending tool calls before adding a new message
    if (pendingToolCalls.length > 0) {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: pendingToolCalls,
      });
      pendingToolCalls = [];
    }

    const converted = convertMessage(message, lineage, options);
    if (converted && message.role !== 'tool-call') {
      messages.push(converted);
    }
  }

  // Flush any remaining tool calls
  if (pendingToolCalls.length > 0) {
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: pendingToolCalls,
    });
  }

  return { messages, lineage };
}
