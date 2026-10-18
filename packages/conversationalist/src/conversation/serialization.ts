import { z } from 'zod';

import {
  createInvalidPositionError,
  createSerializationError,
  createUnsupportedSchemaVersionError,
} from '../errors';
import { conversationShape, messageSchema } from '../schemas';
import {
  CURRENT_SCHEMA_VERSION,
  type AssistantMessage,
  type ConversationHistory,
  type ConversationHistoryHeader,
  type Message,
  type ToolResult,
} from '../types';
import { createMessage, isAssistantMessage, toReadonly } from '../utilities';
import { toIdRecord } from '../utilities/message-store';
import { assertConversationHistoryIntegrity } from './integrity';
import { assertToolReference, type ToolUseIndex } from './tool-tracking';

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

function invalidDataError(): Error {
  return createSerializationError('failed to deserialize conversation: invalid data');
}

/**
 * Parses one serialized message: the per-message, schema-validated half of
 * {@link deserializeConversationHistory}. The result is an immutable message
 * instance; whether it fits the conversation around it (its position, the tool
 * call it answers) is {@link assembleConversationHistory}'s job.
 */
export function parseConversationMessage(json: unknown): Message {
  const parsed = messageSchema.safeParse(json);
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
  // Refuse another schema version before shape validation, so stored data from
  // an older build is told apart from corrupt data. There is no dual reader.
  if (isRecord(json) && typeof json['schemaVersion'] === 'number') {
    if (json['schemaVersion'] !== CURRENT_SCHEMA_VERSION) {
      throw createUnsupportedSchemaVersionError(json['schemaVersion'], CURRENT_SCHEMA_VERSION);
    }
  }
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

const conversationStatuses: ReadonlySet<unknown> = new Set(['active', 'archived', 'deleted']);
const conversationHeaderKeys: ReadonlySet<string> = new Set([
  'schemaVersion',
  'id',
  'title',
  'status',
  'metadata',
  'createdAt',
  'updatedAt',
]);

function invalidHeaderError(detail: string): Error {
  return createSerializationError(`failed to deserialize conversation: invalid header ${detail}`);
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Copies a JSON value, accepting exactly what `jsonValueSchema` accepts:
 * strings, finite numbers, booleans, null, arrays, and plain objects of those.
 * `ancestors` holds the containers being copied, so a cycle is rejected rather
 * than walked forever, while a value shared by two branches is still accepted.
 */
function copyJsonValue(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidHeaderError('metadata: non-finite number');
    return value;
  }
  const isArray = Array.isArray(value);
  if (!isArray && !isPlainJsonObject(value)) throw invalidHeaderError('metadata: not JSON');
  if (ancestors.has(value)) throw invalidHeaderError('metadata: cycle');
  ancestors.add(value);
  let copy: unknown;
  if (isArray) {
    copy = Array.from({ length: value.length }, (_, index) =>
      copyJsonValue(value[index], ancestors),
    );
  } else {
    // `fromEntries` defines each key, so a `__proto__` key stays an own property.
    copy = Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, copyJsonValue(nested, ancestors)]),
    );
  }
  ancestors.delete(value);
  return copy;
}

/**
 * Reads a conversation header (everything but `ids` and `messages`) without
 * zod. It accepts exactly what the header fields of `conversationShape` accept
 * under `.strict()`, and returns a copy, so freezing the result never freezes
 * the caller's input.
 *
 * Snapshot restore reads one header per history node. Messages are
 * schema-validated once per table entry, and this keeps the per-node work free
 * of schema parsing too. {@link parseConversationFrame} stays the
 * schema-backed reader for whole conversations; a test checks that the two
 * accept and reject the same headers.
 */
export function readConversationHistoryHeader(value: unknown): ConversationHistoryHeader {
  if (!isRecord(value)) throw invalidHeaderError('shape');
  for (const key of Object.keys(value)) {
    if (!conversationHeaderKeys.has(key)) throw invalidHeaderError(`field ${key}`);
  }
  const { schemaVersion, id, title, status, metadata, createdAt, updatedAt } = value;
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw invalidHeaderError('schemaVersion');
  }
  if (schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw createUnsupportedSchemaVersionError(schemaVersion, CURRENT_SCHEMA_VERSION);
  }
  if (typeof id !== 'string') throw invalidHeaderError('id');
  if (title !== undefined && typeof title !== 'string') throw invalidHeaderError('title');
  if (!conversationStatuses.has(status)) throw invalidHeaderError('status');
  if (!isPlainJsonObject(metadata)) throw invalidHeaderError('metadata');
  if (typeof createdAt !== 'string') throw invalidHeaderError('createdAt');
  if (typeof updatedAt !== 'string') throw invalidHeaderError('updatedAt');
  return {
    schemaVersion,
    id,
    title,
    status: status as ConversationHistoryHeader['status'],
    metadata: copyJsonValue(metadata, new Set()) as ConversationHistoryHeader['metadata'],
    createdAt,
    updatedAt,
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
 * @param json - The conversation JSON to deserialize (must carry the current schema version)
 * @returns A ConversationHistory object
 * @throws {SerializationError} If validation fails
 */
export function deserializeConversationHistory(json: unknown): ConversationHistory {
  const frame = parseConversationFrame(json);
  const messages: Record<string, Message> = {};
  for (const [id, message] of Object.entries(frame.messages)) {
    messages[id] = parseConversationMessage(message);
  }
  return assembleConversationHistory(frame.header, frame.ids, messages);
}
