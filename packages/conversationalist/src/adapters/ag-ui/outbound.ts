import type { Message as AGUIMessage, AssistantMessage, ToolCall } from '@ag-ui/core';
import { MessageSchema } from '@ag-ui/core/schemas';
import { assertConversationSafe } from '../../conversation/validation';
import type { MultiModalContent } from '../../multi-modal';
import { isStreamingMessage } from '../../streaming';
import type {
  ConversationHistory as Conversation,
  Message,
  ToolCall as MessageToolCall,
  ToolResult,
} from '../../types';
import { getOrderedMessages } from '../../utilities/message-store';
import { stringifyToolResult } from '../shared';
import { toAGUIContent, toAGUIText } from './content';
import { AGUIMappingError, unsupportedAGUIContent } from './errors';

/** Id suffix joining an assistant message id to the n-th reasoning message before it. */
const REASONING_ID_SEPARATOR = ':reasoning:';

/**
 * Converts a conversation to the AG-UI 1.0 `messages` of a `MESSAGES_SNAPSHOT`
 * event.
 *
 * - `system`, `developer`, and `user` messages map to their AG-UI roles with
 *   the same id; system and developer content is text only.
 * - An `assistant` message maps to an assistant message. Its `thinking` parts
 *   become `reasoning` messages placed before it, with the signature as the
 *   reasoning message's `encryptedValue`, so reasoning is hoisted ahead of the
 *   text. Text parts join with a blank line. A `redacted_thinking` part throws
 *   an `AGUIMappingError`: AG-UI has no way to carry withheld reasoning.
 * - Consecutive `tool-call` messages collapse into one assistant message with
 *   `toolCalls`; a `tool-result` becomes a `tool` message whose content is the
 *   serialized result, with `error` set to the failure message.
 * - Hidden, streaming, and `snapshot` messages are skipped, as in the provider
 *   adapters. Token usage, goal completion, and cache boundaries have no AG-UI
 *   field and are not exported.
 *
 * Every message is parsed with the `@ag-ui/core` message schema before it is
 * returned, so the result is always a valid snapshot payload.
 */
export function toAGUIMessages(conversation: Conversation): AGUIMessage[] {
  assertConversationSafe(conversation);
  const messages: AGUIMessage[] = [];
  let pendingToolCalls: { id: string; calls: ToolCall[] } | undefined;

  const flushToolCalls = (): void => {
    if (pendingToolCalls === undefined) return;
    messages.push({
      id: pendingToolCalls.id,
      role: 'assistant',
      toolCalls: pendingToolCalls.calls,
    });
    pendingToolCalls = undefined;
  };

  for (const message of getOrderedMessages(conversation)) {
    if (message.hidden || isStreamingMessage(message)) continue;

    if (message.role === 'tool-call') {
      if (!message.toolCall) continue;
      const call = toAGUIToolCall(message, message.toolCall);
      if (pendingToolCalls === undefined) pendingToolCalls = { id: message.id, calls: [call] };
      else pendingToolCalls.calls.push(call);
      continue;
    }

    flushToolCalls();
    messages.push(...convertMessage(message));
  }
  flushToolCalls();

  return messages.map(validateAGUIMessage);
}

function validateAGUIMessage(message: AGUIMessage): AGUIMessage {
  const result = MessageSchema.safeParse(message);
  if (result.success) return message;
  throw new AGUIMappingError(
    'message',
    `Message ${message.id} does not satisfy the AG-UI 1.0 message schema: ${result.error.message}`,
    { messageId: message.id },
  );
}

function convertMessage(message: Message): AGUIMessage[] {
  const metadata = toAGUIMetadata(message);
  switch (message.role) {
    case 'system':
    case 'developer':
      return [
        {
          id: message.id,
          role: message.role,
          content: toAGUIText(message.content, message.role),
          ...metadata,
        },
      ];

    case 'user':
      return [
        {
          id: message.id,
          role: 'user',
          content: toAGUIContent(message.content, 'user'),
          ...metadata,
        },
      ];

    case 'assistant':
      return convertAssistantMessage(message);

    case 'tool-result':
      return message.toolResult ? [convertToolResult(message, message.toolResult, metadata)] : [];

    default:
      return [];
  }
}

function convertAssistantMessage(message: Message): AGUIMessage[] {
  const parts: ReadonlyArray<MultiModalContent> =
    typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content;
  const reasoning: AGUIMessage[] = [];
  const text: MultiModalContent[] = [];

  for (const part of parts) {
    if (part.type === 'thinking') {
      reasoning.push({
        id: `${message.id}${REASONING_ID_SEPARATOR}${reasoning.length}`,
        role: 'reasoning',
        content: part.thinking,
        encryptedValue: part.signature,
      });
    } else if (part.type === 'redacted_thinking') {
      throw unsupportedAGUIContent(
        part.type,
        'AG-UI reasoning messages carry no redacted reasoning, so it cannot be exported without loss.',
      );
    } else {
      text.push(part);
    }
  }

  const content = toAGUIText(text, 'assistant');
  const assistant: AssistantMessage = {
    id: message.id,
    role: 'assistant',
    ...(content.length > 0 ? { content } : {}),
    ...toAGUIMetadata(message),
  };
  return [...reasoning, assistant];
}

function toAGUIToolCall(message: Message, toolCall: Readonly<MessageToolCall>): ToolCall {
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
    ...toAGUIMetadata(message),
  };
}

function convertToolResult(
  message: Message,
  toolResult: Readonly<ToolResult>,
  metadata: ReturnType<typeof toAGUIMetadata>,
): AGUIMessage {
  return {
    id: message.id,
    role: 'tool',
    toolCallId: toolResult.callId,
    content: stringifyToolResult(toolResult),
    ...(toolResult.error ? { error: toolResult.error.message } : {}),
    ...metadata,
  };
}

function toAGUIMetadata(message: Message): { metadata?: Record<string, unknown> } {
  return Object.keys(message.metadata).length > 0 ? { metadata: { ...message.metadata } } : {};
}
