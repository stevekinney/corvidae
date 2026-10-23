import { isRecord } from './stream-event-codec-validation.ts';

/**
 * The conversation schema a wire version 1, 2, or 3 `run.completed` frame
 * carries: the one Conversationalist wrote before `providerCallId` provenance
 * arrived. Clients of those versions validate it strictly.
 */
const LEGACY_WIRE_CONVERSATION_SCHEMA_VERSION = 7;

/** The schema the current Conversationalist writes, and a wire version 4 frame carries. */
const CURRENT_WIRE_CONVERSATION_SCHEMA_VERSION = 8;

function withoutProviderCallId(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const { providerCallId: _providerCallId, ...rest } = value;
  return rest;
}

/**
 * Projects a validated schema 8 conversation onto the schema 7 shape a wire
 * version 1, 2, or 3 client accepts: every tool call and tool result loses
 * its `providerCallId`, and `schemaVersion` reads 7.
 */
export function projectLegacyWireConversation(conversation: unknown): unknown {
  if (!isRecord(conversation)) return conversation;
  const source = conversation['messages'];
  if (!isRecord(source)) return conversation;
  const messages = Object.fromEntries(
    Object.entries(source).map(([id, message]) => {
      if (!isRecord(message)) return [id, message];
      return [
        id,
        {
          ...message,
          ...(message['toolCall'] === undefined
            ? {}
            : { toolCall: withoutProviderCallId(message['toolCall']) }),
          ...(message['toolResult'] === undefined
            ? {}
            : { toolResult: withoutProviderCallId(message['toolResult']) }),
        },
      ];
    }),
  );
  return { ...conversation, messages, schemaVersion: LEGACY_WIRE_CONVERSATION_SCHEMA_VERSION };
}

/**
 * Lifts a schema 7 conversation read from a wire version 1, 2, or 3 frame to
 * schema 8, which only adds an optional field. A conversation at any other
 * version is returned untouched, so the caller's validation still refuses it.
 */
export function liftLegacyWireConversation(conversation: unknown): unknown {
  if (
    !isRecord(conversation) ||
    conversation['schemaVersion'] !== LEGACY_WIRE_CONVERSATION_SCHEMA_VERSION
  )
    return conversation;
  return { ...conversation, schemaVersion: CURRENT_WIRE_CONVERSATION_SCHEMA_VERSION };
}
