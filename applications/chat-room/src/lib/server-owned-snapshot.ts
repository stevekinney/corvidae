import type { ChatSerializedRunError, ConversationHistory } from '@corvidae/chat';
/** The browser-safe projection persisted by the server-owned conversation route. */
export type ServerOwnedConversationSnapshot = {
  id: string;
  title: string;
  conversation: ConversationHistory;
  turnFailures: Record<string, ServerOwnedTurnFailure>;
};
/** Redacted classified failure persisted by the server-owned session. */
export type ServerOwnedTurnFailure = Omit<ChatSerializedRunError, 'name'>;
export const SERVER_OWNED_PERSISTENCE_FAILURE_MESSAGE = 'The turn outcome could not be saved.';
export type ServerOwnedPersistenceFailureHint = {
  source: 'server-owned-persistence';
  userMessageId: string;
  failure: {
    kind: 'generate';
    code: 'UNKNOWN';
    message: typeof SERVER_OWNED_PERSISTENCE_FAILURE_MESSAGE;
    retryable: false;
  };
};
/** Builds the browser-only hint for a failure that could not be persisted. */
export function serverOwnedPersistenceFailureHint(
  userMessageId: string,
): ServerOwnedPersistenceFailureHint {
  if (userMessageId.length === 0) throw new Error('A failed user message id is required.');
  return {
    source: 'server-owned-persistence',
    userMessageId,
    failure: {
      kind: 'generate',
      code: 'UNKNOWN',
      message: SERVER_OWNED_PERSISTENCE_FAILURE_MESSAGE,
      retryable: false,
    },
  };
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}

function isPersistenceFailure(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['kind', 'code', 'message', 'retryable']) &&
    value['kind'] === 'generate' &&
    value['code'] === 'UNKNOWN' &&
    value['message'] === SERVER_OWNED_PERSISTENCE_FAILURE_MESSAGE &&
    value['retryable'] === false
  );
}

/** Strictly validates a decoded persistence hint before local overlay use. */
export function parseServerOwnedPersistenceFailureHint(
  value: unknown,
): ServerOwnedPersistenceFailureHint | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['source', 'userMessageId', 'failure'])) {
    return undefined;
  }
  const userMessageId = value['userMessageId'];
  if (value['source'] !== 'server-owned-persistence') return undefined;
  if (typeof userMessageId !== 'string' || userMessageId.length === 0) return undefined;
  if (!isPersistenceFailure(value['failure'])) return undefined;
  return serverOwnedPersistenceFailureHint(userMessageId);
}
