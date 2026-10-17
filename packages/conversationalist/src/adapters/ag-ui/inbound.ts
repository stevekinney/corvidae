import type { Message as AGUIMessage, AssistantMessage } from '@ag-ui/core';
import { MessageSchema } from '@ag-ui/core/schemas';
import { appendMessages, createConversationHistory } from '../../conversation/index';
import type { ThinkingContent } from '../../multi-modal';
import type { ConversationHistory as Conversation, MessageInput } from '../../types';
import { parseJSONValue, toJSONValue } from '../shared';
import { fromAGUIContent, readTextParts, withoutTextParts } from './content';
import { AGUIMappingError } from './errors';
import { callRowId } from './ids';
import { fromAGUIToolMessage, withoutEmbeddedResult } from './tool-result';

export { fromAGUIToolMessage };

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

/** A message input that carries the id AG-UI gave the message it came from. */
type IdentifiedInput = MessageInput & { id: string };

function toAssistantInputs(
  message: AssistantMessage,
  pendingReasoning: ThinkingContent[],
): IdentifiedInput[] {
  const inputs: IdentifiedInput[] = [];
  const text = message.content ?? '';
  const hasContentRow = pendingReasoning.length > 0 || text.length > 0;
  const parts = readTextParts(message.metadata, text);

  if (hasContentRow) {
    const textParts = parts ?? (text.length > 0 ? [{ type: 'text' as const, text }] : []);
    inputs.push({
      id: message.id,
      role: 'assistant',
      content:
        pendingReasoning.length > 0 || parts !== undefined
          ? [...pendingReasoning, ...textParts]
          : text,
      ...toMetadata(withoutTextParts(message.metadata)),
    });
  }

  (message.toolCalls ?? []).forEach((toolCall, index) => {
    inputs.push({
      id: index === 0 && !hasContentRow ? message.id : callRowId(message.id, toolCall.id),
      role: 'tool-call',
      content: '',
      toolCall: {
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: parseJSONValue(toolCall.function.arguments) ?? toolCall.function.arguments,
      },
      ...toMetadata(toolCall.metadata),
    });
  });

  return inputs;
}

function toMessageInputs(messages: ReadonlyArray<AGUIMessage>): IdentifiedInput[] {
  assertValidAGUIMessages(messages);
  const inputs: IdentifiedInput[] = [];
  let pendingReasoning: ThinkingContent[] = [];
  let pendingReasoningId = '';

  // Reasoning with no assistant message after it stands as a row of its own,
  // under the id of the last reasoning message.
  const flushReasoning = (): void => {
    if (pendingReasoning.length === 0) return;
    inputs.push({ id: pendingReasoningId, role: 'assistant', content: pendingReasoning });
    pendingReasoning = [];
  };

  for (const message of messages) {
    if (message.role === 'reasoning') {
      pendingReasoning.push({
        type: 'thinking',
        thinking: message.content,
        signature: message.encryptedValue ?? '',
      });
      pendingReasoningId = message.id;
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
          id: message.id,
          role: message.role,
          content: readTextParts(message.metadata, message.content) ?? message.content,
          ...toMetadata(withoutTextParts(message.metadata)),
        });
        break;
      case 'user':
        inputs.push({
          id: message.id,
          role: 'user',
          content: fromAGUIContent(message.content),
          ...toMetadata(message.metadata),
        });
        break;
      case 'tool':
        inputs.push({
          id: message.id,
          role: 'tool-result',
          content: '',
          toolResult: fromAGUIToolMessage(message),
          ...toMetadata(withoutEmbeddedResult(message.metadata)),
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
 * progress, not conversation content.
 *
 * Message ids are kept, and a message that splits into several rows derives
 * their ids from its own, so `toAGUIMessages(fromAGUIMessages(x))` reproduces
 * the ids of `x` (reasoning messages excepted, which export names
 * `<assistant id>:reasoning:<n>`). Ids are what identify a message to the
 * AG-UI backend and to anything that persisted it, so they are not minted
 * locally. Because `appendMessages` treats an input that carries an `id` as an
 * already-built message, conversation plugins do not run over imported
 * messages (and the adapter takes no environment to configure them with): a
 * remote history is not new user input for a plugin to shape. Two
 * messages that end up with the same row id throw a `duplicate-id` error.
 */
export function fromAGUIMessages(messages: ReadonlyArray<AGUIMessage>): Conversation {
  return appendAGUIMessages(createConversationHistory(), messages);
}

/**
 * Appends AG-UI messages to an existing conversation; see
 * {@link fromAGUIMessages}. A message whose id is already in the conversation
 * throws a `duplicate-id` error; use {@link mergeAGUIMessages} to skip them.
 */
export function appendAGUIMessages(
  conversation: Conversation,
  messages: ReadonlyArray<AGUIMessage>,
): Conversation {
  const inputs = toMessageInputs(messages);
  if (inputs.length === 0) return conversation;
  return appendMessages(conversation, ...inputs);
}

/**
 * Merges AG-UI messages into a conversation by id: a message that becomes a row
 * whose id is already in the conversation is skipped, and the conversation's
 * own row stands. The conversation is authoritative, so the merge only ever
 * adds rows and never changes or removes one. This is how a
 * `MESSAGES_SNAPSHOT` of a whole thread meets a conversation that already
 * holds part of it. New rows are appended in the order the messages give them.
 * A `tool-call` row is also skipped when the conversation already holds a call
 * with the same `toolCall.id` under another row id, because a call is the same
 * call whichever message a backend files it under and a conversation cannot
 * hold one twice.
 */
export function mergeAGUIMessages(
  conversation: Conversation,
  messages: ReadonlyArray<AGUIMessage>,
): Conversation {
  const heldCalls = new Set(
    Object.values(conversation.messages).flatMap((row) => (row.toolCall ? [row.toolCall.id] : [])),
  );
  const inputs = toMessageInputs(messages).filter(
    (input) =>
      conversation.messages[input.id] === undefined &&
      (input.toolCall === undefined || !heldCalls.has(input.toolCall.id)),
  );
  if (inputs.length === 0) return conversation;
  return appendMessages(conversation, ...inputs);
}
