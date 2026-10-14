import { z } from 'zod';

import { createInvalidPositionError, createSerializationError } from '../errors';
import { conversationShape, messageSchema } from '../schemas';
import type {
  AssistantMessage,
  ConversationHistory,
  ConversationHistoryHeader,
  Message,
  ToolResult,
} from '../types';
import { createMessage, isAssistantMessage, toReadonly } from '../utilities';
import { toIdRecord } from '../utilities/message-store';
import { assertConversationHistoryIntegrity } from './integrity';
import { assertToolReference, type ToolUseIndex } from './tool-tracking';

function normalizeLegacyToolCall(toolCall: unknown): unknown {
  if (!isRecord(toolCall)) {
    return toolCall;
  }

  const record = { ...toolCall };

  if (!('arguments' in record) && 'args' in record) {
    record['arguments'] = record['args'];
  }

  delete record['args'];

  return record;
}

function normalizeLegacyToolResult(toolResult: unknown): unknown {
  if (!isRecord(toolResult)) {
    return toolResult;
  }

  const record = { ...toolResult };

  if (!('content' in record) && 'result' in record) {
    record['content'] = record['result'];
  }

  delete record['result'];

  return record;
}

function normalizeLegacyMessage(messageValue: unknown): unknown {
  if (!isRecord(messageValue)) return messageValue;
  const message = { ...messageValue };
  if (message['role'] === 'tool-use') message['role'] = 'tool-call';
  if ('toolCall' in message) message['toolCall'] = normalizeLegacyToolCall(message['toolCall']);
  if ('toolResult' in message) {
    message['toolResult'] = normalizeLegacyToolResult(message['toolResult']);
  }
  return message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeToolResult(toolResult: Message['toolResult']): ToolResult | undefined {
  if (!toolResult) return undefined;
  return {
    callId: toolResult.callId,
    outcome: toolResult.outcome,
    content: toolResult.content,
    ...(toolResult.error ? { error: { ...toolResult.error } } : {}),
    ...(toolResult.action ? { action: { ...toolResult.action } } : {}),
    ...(toolResult.inputDigest ? { inputDigest: toolResult.inputDigest } : {}),
    ...(toolResult.outputDigest ? { outputDigest: toolResult.outputDigest } : {}),
  };
}

function normalizeMessage(message: Message): Message | AssistantMessage {
  const base: Message = {
    id: message.id,
    role: message.role,
    content: message.content,
    position: message.position,
    createdAt: message.createdAt,
    metadata: message.metadata,
    hidden: message.hidden,
    toolCall: message.toolCall ? { ...message.toolCall } : undefined,
    toolResult: normalizeToolResult(message.toolResult),
    tokenUsage: message.tokenUsage ? { ...message.tokenUsage } : undefined,
    cacheBoundary: message.cacheBoundary,
  };

  if (isAssistantMessage(message)) {
    return {
      ...base,
      role: 'assistant',
      goalCompleted: message.goalCompleted,
    };
  }

  return base;
}

/** Whether a serialized message uses a shape only {@link normalizeLegacyMessage} accepts. */
function isLegacyMessage(message: unknown): boolean {
  if (!isRecord(message)) return false;
  if (message['role'] === 'tool-use') return true;
  const toolCall = message['toolCall'];
  if (isRecord(toolCall) && 'args' in toolCall) return true;
  const toolResult = message['toolResult'];
  return isRecord(toolResult) && 'result' in toolResult;
}

/**
 * How a serialized message is read: `legacy` coerces shapes older versions
 * wrote (a `tool-use` role, `args`, `result`); `current` rejects them, because
 * a payload that claims the current schema version, such as a version 2
 * snapshot's message table, must not need coercion.
 */
export type SerializedMessageShape = 'legacy' | 'current';

function legacyShapeError(): Error {
  return createSerializationError(
    'failed to deserialize conversation: legacy payload shape under the current schema version',
  );
}

function invalidDataError(): Error {
  return createSerializationError('failed to deserialize conversation: invalid data');
}

/**
 * Parses one serialized message: the per-message, schema-validated half of
 * {@link deserializeConversationHistory}. The result is an immutable message
 * instance; whether it fits the conversation around it (its position, the tool
 * call it answers) is {@link assembleConversationHistory}'s job.
 */
export function parseConversationMessage(json: unknown, shape: SerializedMessageShape): Message {
  if (shape === 'current' && isLegacyMessage(json)) throw legacyShapeError();
  const parsed = messageSchema.safeParse(shape === 'legacy' ? normalizeLegacyMessage(json) : json);
  if (!parsed.success) throw invalidDataError();
  return createMessage(normalizeMessage(parsed.data));
}

/**
 * Everything in a conversation except its messages: the conversation shape
 * with each message left unparsed, so messages are validated one at a time by
 * {@link parseConversationMessage}.
 */
const conversationFrameSchema = z
  .object({ ...conversationShape, messages: z.record(z.string(), z.unknown()) })
  .strict();

/** A schema-validated conversation whose messages have not been parsed yet. */
export interface ConversationFrame {
  readonly header: ConversationHistoryHeader;
  readonly ids: readonly string[];
  readonly messages: Readonly<Record<string, unknown>>;
}

/** Parses a conversation's header, ids, and message record, leaving each message unparsed. */
export function parseConversationFrame(json: unknown): ConversationFrame {
  const parsed = conversationFrameSchema.safeParse(json);
  if (!parsed.success) throw invalidDataError();
  const { ids, messages, ...header } = parsed.data;
  return {
    header: {
      schemaVersion: header.schemaVersion,
      id: header.id,
      title: header.title,
      status: header.status,
      metadata: { ...header.metadata },
      createdAt: header.createdAt,
      updatedAt: header.updatedAt,
    },
    ids,
    messages,
  };
}

/**
 * Assembles parsed messages into a conversation: the history half of
 * {@link deserializeConversationHistory}. It runs no schema validation, only
 * the checks that depend on how messages sit together: every listed id has a
 * message at its index's position, every message is listed, each tool result
 * follows its call, and {@link assertConversationHistoryIntegrity}.
 *
 * Message instances are kept as given, so conversations assembled from the
 * same parsed messages share them.
 */
export function assembleConversationHistory(
  header: ConversationHistoryHeader,
  ids: readonly string[],
  messages: Readonly<Record<string, Message>>,
): ConversationHistory {
  try {
    const unlisted = new Set(Object.keys(messages));
    const toolUses: ToolUseIndex = new Map();
    const orderedMessages = ids.map((id, index) => {
      const message = messages[id];
      if (!message) throw createSerializationError(`missing message for id ${id}`);
      if (message.position !== index) throw createInvalidPositionError(index, message.position);
      unlisted.delete(id);
      if (message.role === 'tool-call' && message.toolCall) {
        toolUses.set(message.toolCall.id, { name: message.toolCall.name });
      }
      if (message.role === 'tool-result' && message.toolResult) {
        assertToolReference(toolUses, message.toolResult.callId);
      }
      return message;
    });
    if (unlisted.size > 0) {
      throw createSerializationError(`messages not listed in ids: ${[...unlisted].join(', ')}`);
    }

    const conversation = toReadonly<ConversationHistory>({
      ...header,
      ids: orderedMessages.map((message) => message.id),
      messages: toIdRecord(orderedMessages),
    });
    assertConversationHistoryIntegrity(conversation);
    return conversation;
  } catch (error) {
    throw createSerializationError(
      `failed to deserialize conversation: ${
        error instanceof Error ? error.message : String(error)
      }`,
      error instanceof Error ? error : undefined,
    );
  }
}

/**
 * Reconstructs a conversation from a JSON object.
 * Validates message positions are contiguous and tool results reference valid calls.
 * Throws a serialization error if validation fails.
 *
 * It is {@link parseConversationMessage} for each message followed by
 * {@link assembleConversationHistory}; snapshot restore calls the same two
 * halves, parsing each stored message once and assembling every history node.
 *
 * @param json - The conversation JSON to deserialize (may be from an older version)
 * @returns A ConversationHistory object
 * @throws {SerializationError} If validation fails
 */
export function deserializeConversationHistory(json: unknown): ConversationHistory {
  const frame = parseConversationFrame(json);
  const messages: Record<string, Message> = {};
  for (const [id, message] of Object.entries(frame.messages)) {
    messages[id] = parseConversationMessage(message, 'legacy');
  }
  return assembleConversationHistory(frame.header, frame.ids, messages);
}
