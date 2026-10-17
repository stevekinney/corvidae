import type { Message as AGUIMessage, AssistantMessage, ToolCall } from '@ag-ui/core';
import { MessageSchema } from '@ag-ui/core/schemas';
import { assertConversationSafe } from '../../conversation/validation';
import type { MultiModalContent } from '../../multi-modal';
import { isStreamingMessage } from '../../streaming';
import type {
  ConversationHistory as Conversation,
  Message,
  ToolCall as MessageToolCall,
} from '../../types';
import { getOrderedMessages } from '../../utilities/message-store';
import { toAGUIContent, toAGUIText } from './content';
import { AGUIMappingError, unsupportedAGUIContent } from './errors';
import { callRowParent, REASONING_ID_SEPARATOR } from './ids';
import { toAGUIToolMessage } from './tool-result';

/**
 * Converts a conversation to the AG-UI 1.0 `messages` of a `MESSAGES_SNAPSHOT`
 * event.
 *
 * - Every message keeps its id: `system`, `developer`, `user`, `assistant`,
 *   and `tool-result` messages map to their AG-UI roles under the same id;
 *   system and developer content is text only.
 * - An `assistant` message maps to an assistant message. Its `thinking` parts
 *   become `reasoning` messages placed before it, with the signature as the
 *   reasoning message's `encryptedValue`, so reasoning is hoisted ahead of the
 *   text. Text parts join with a blank line. A `redacted_thinking` part throws
 *   an `AGUIMappingError`: AG-UI has no way to carry withheld reasoning.
 * - A `tool-call` message becomes an assistant message with one entry in
 *   `toolCalls` under its own id, unless its id was derived from an assistant
 *   message's (see `ids.ts`), in which case it joins that message. A
 *   `tool-result` becomes a `tool` message whose content is the serialized
 *   result, with `error` set to the failure message.
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

  for (const message of getOrderedMessages(conversation)) {
    if (message.hidden || isStreamingMessage(message)) continue;

    if (message.role === 'tool-call') {
      if (message.toolCall) addToolCall(messages, message, message.toolCall);
      continue;
    }

    messages.push(...convertMessage(message));
  }

  return messages.map(validateAGUIMessage);
}

/**
 * Writes one `tool-call` row. A row whose id was derived from an assistant
 * message's joins that message when it is the one just written, which is how
 * an assistant message with text and calls, or with several calls, comes back
 * whole; any other row is an assistant message of its own under its own id.
 */
function addToolCall(
  messages: AGUIMessage[],
  message: Message,
  toolCall: Readonly<MessageToolCall>,
): void {
  const call = toAGUIToolCall(message, toolCall);
  const parentId = callRowParent(message.id, toolCall.id);
  const last = messages.at(-1);
  if (parentId !== undefined && last?.role === 'assistant' && last.id === parentId) {
    messages[messages.length - 1] = { ...last, toolCalls: [...(last.toolCalls ?? []), call] };
    return;
  }
  messages.push({ id: message.id, role: 'assistant', toolCalls: [call] });
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
    case 'developer': {
      const { text, metadata: extra } = toAGUIText(message.content, message.role);
      return [
        {
          id: message.id,
          role: message.role,
          content: text,
          ...mergeMetadata(metadata.metadata, extra),
        },
      ];
    }

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
      return message.toolResult
        ? [toAGUIToolMessage(message.id, message.toolResult, metadata.metadata ?? {})]
        : [];

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

  const { text: content, metadata: extra } = toAGUIText(text, 'assistant');
  const assistant: AssistantMessage = {
    id: message.id,
    role: 'assistant',
    ...(content.length > 0 ? { content } : {}),
    ...mergeMetadata(toAGUIMetadata(message).metadata, extra),
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

function mergeMetadata(
  metadata: Record<string, unknown> | undefined,
  extra: Record<string, unknown>,
): { metadata?: Record<string, unknown> } {
  const merged = { ...metadata, ...extra };
  return Object.keys(merged).length > 0 ? { metadata: merged } : {};
}

function toAGUIMetadata(message: Message): { metadata?: Record<string, unknown> } {
  return Object.keys(message.metadata).length > 0 ? { metadata: { ...message.metadata } } : {};
}
