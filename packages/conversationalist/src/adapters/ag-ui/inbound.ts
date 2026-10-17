import type { Message as AGUIMessage, AssistantMessage } from '@ag-ui/core';
import { MessageSchema } from '@ag-ui/core/schemas';
import { appendMessages, createConversationHistory } from '../../conversation/index';
import type { ThinkingContent } from '../../multi-modal';
import type { ConversationHistory as Conversation, MessageInput, ToolResult } from '../../types';
import { parseJSONValue, parseToolResultText, toJSONValue } from '../shared';
import { fromAGUIContent } from './content';
import { AGUIMappingError } from './errors';

function assertValidAGUIMessages(messages: ReadonlyArray<AGUIMessage>): void {
  messages.forEach((message, index) => {
    const result = MessageSchema.safeParse(message);
    if (result.success) return;
    throw new AGUIMappingError(
      'message',
      `Message at index ${index} does not satisfy the AG-UI 1.0 message schema: ${result.error.message}`,
      { index },
    );
  });
}

function toMetadata(metadata: Record<string, unknown> | undefined): Pick<MessageInput, 'metadata'> {
  if (metadata === undefined || Object.keys(metadata).length === 0) return {};
  return {
    metadata: Object.fromEntries(
      Object.entries(metadata).map(([key, value]) => [key, toJSONValue(value)]),
    ),
  };
}

/**
 * Converts one AG-UI `tool` message to the tool result it carries; the inverse
 * of how {@link toAGUIMessages} writes a result. Content that spells out a
 * canonical result payload keeps that outcome, and otherwise the result is a
 * success whose content is the text, unless the message's `error` field says
 * the tool failed. A streaming consumer that sees a result before it has a
 * conversation to import reads it with this.
 */
export function fromAGUIToolMessage(message: Extract<AGUIMessage, { role: 'tool' }>): ToolResult {
  const serialized =
    typeof message.content === 'string'
      ? message.content
      : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n\n');
  const result = parseToolResultText(message.toolCallId, serialized);
  if (message.error === undefined || result.outcome !== 'success') return result;
  return {
    ...result,
    outcome: 'error',
    error: {
      code: 'ag-ui.tool-error',
      category: 'internal',
      retryable: false,
      message: message.error,
    },
  };
}

function toAssistantInputs(
  message: AssistantMessage,
  pendingReasoning: ThinkingContent[],
): MessageInput[] {
  const inputs: MessageInput[] = [];
  const text = message.content ?? '';

  if (pendingReasoning.length > 0 || text.length > 0) {
    inputs.push({
      role: 'assistant',
      content:
        pendingReasoning.length > 0
          ? [...pendingReasoning, ...(text.length > 0 ? [{ type: 'text' as const, text }] : [])]
          : text,
      ...toMetadata(message.metadata),
    });
  }

  for (const toolCall of message.toolCalls ?? []) {
    inputs.push({
      role: 'tool-call',
      content: '',
      toolCall: {
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: parseJSONValue(toolCall.function.arguments) ?? toolCall.function.arguments,
      },
      ...toMetadata(toolCall.metadata),
    });
  }

  return inputs;
}

function toMessageInputs(messages: ReadonlyArray<AGUIMessage>): MessageInput[] {
  assertValidAGUIMessages(messages);
  const inputs: MessageInput[] = [];
  let pendingReasoning: ThinkingContent[] = [];

  const flushReasoning = (): void => {
    if (pendingReasoning.length === 0) return;
    inputs.push({ role: 'assistant', content: pendingReasoning });
    pendingReasoning = [];
  };

  for (const message of messages) {
    if (message.role === 'reasoning') {
      pendingReasoning.push({
        type: 'thinking',
        thinking: message.content,
        signature: message.encryptedValue ?? '',
      });
      continue;
    }

    if (message.role === 'assistant') {
      inputs.push(...toAssistantInputs(message, pendingReasoning));
      pendingReasoning = [];
      continue;
    }

    flushReasoning();
    switch (message.role) {
      case 'system':
      case 'developer':
        inputs.push({
          role: message.role,
          content: message.content,
          ...toMetadata(message.metadata),
        });
        break;
      case 'user':
        inputs.push({
          role: 'user',
          content: fromAGUIContent(message.content),
          ...toMetadata(message.metadata),
        });
        break;
      case 'tool':
        inputs.push({
          role: 'tool-result',
          content: '',
          toolResult: fromAGUIToolMessage(message),
          ...toMetadata(message.metadata),
        });
        break;
      default:
        // Activity messages are structured progress, not conversation content.
        break;
    }
  }
  flushReasoning();

  return inputs;
}

/**
 * Converts the `messages` of an AG-UI 1.0 `MESSAGES_SNAPSHOT` event into a
 * ConversationHistory; the inverse of {@link toAGUIMessages}.
 *
 * Each message is first parsed with the `@ag-ui/core` message schema, and one
 * that fails throws an `AGUIMappingError`. An assistant message becomes an
 * assistant message plus one `tool-call` message per entry in `toolCalls`;
 * `reasoning` messages become `thinking` parts of the assistant message that
 * follows them, with `encryptedValue` as the signature; a `tool` message
 * becomes a `tool-result`. `activity` messages are skipped: they are UI
 * progress, not conversation content. AG-UI message ids are not adopted, so
 * conversation plugins run and local ids are minted.
 */
export function fromAGUIMessages(messages: ReadonlyArray<AGUIMessage>): Conversation {
  return appendAGUIMessages(createConversationHistory(), messages);
}

/** Appends AG-UI messages to an existing conversation; see {@link fromAGUIMessages}. */
export function appendAGUIMessages(
  conversation: Conversation,
  messages: ReadonlyArray<AGUIMessage>,
): Conversation {
  const inputs = toMessageInputs(messages);
  if (inputs.length === 0) return conversation;
  return appendMessages(conversation, ...inputs);
}
