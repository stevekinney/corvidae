import { z } from 'zod';

import { createValidationError } from '../errors';
import { conversationShape, messageSchema } from '../schemas';
import type { ConversationHistory, Message } from '../types';
import { deepFreeze } from '../utilities/type-helpers';
import { assertConversationHistoryIntegrity } from './integrity';

function detachMutableValue<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  if (Array.isArray(value)) return structuredClone(value);
  const detached = { ...value };
  for (const [key, nested] of Object.entries(value)) {
    Object.defineProperty(detached, key, {
      value: detachMutableValue(nested),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return detached;
}

/**
 * The messages {@link ensureConversationSafe} has already validated and deeply
 * frozen. A frozen message cannot change, and every later append shares the
 * same message objects, so validating one again would only repeat work: for a
 * message holding an inline base64 image, that work is decoding the whole
 * payload (COR-716). Membership is by object identity, so a message rebuilt
 * from a snapshot, or copied, is validated again on its own.
 */
const validatedMessages = new WeakSet<Message>();

/** The conversation shape with each message checked separately, so a validated one is skipped. */
const conversationEnvelopeSchema = z
  .object({
    ...conversationShape,
    messages: z.record(
      z.string(),
      z.custom<Message>((value) => typeof value === 'object' && value !== null),
    ),
  })
  .strict();

/**
 * Ensures a conversation conforms to the schema (JSON-safe) and integrity rules.
 * Internal helper for public API enforcement points.
 */
export function assertConversationSafe(conversation: ConversationHistory): void {
  const parsed = conversationEnvelopeSchema.safeParse(conversation);
  if (!parsed.success) {
    throw createValidationError('conversation failed schema validation', {
      issues: parsed.error.issues,
    });
  }
  for (const [id, message] of Object.entries(conversation.messages)) {
    if (validatedMessages.has(message)) continue;
    const result = messageSchema.safeParse(message);
    if (!result.success) {
      throw createValidationError('conversation failed schema validation', {
        issues: result.error.issues.map((issue) => ({
          ...issue,
          path: ['messages', id, ...issue.path],
        })),
      });
    }
  }

  assertConversationHistoryIntegrity(conversation);
}

export function ensureConversationSafe(conversation: ConversationHistory): ConversationHistory {
  assertConversationSafe(conversation);
  const safe = deepFreeze(detachMutableValue(conversation));
  for (const message of Object.values(safe.messages)) validatedMessages.add(message);
  return safe;
}

/**
 * Ensures a standalone message conforms to the schema (JSON-safe).
 * Internal helper for public API enforcement points.
 */
export function assertMessageSafe(message: Message): void {
  const parsed = messageSchema.safeParse(message);
  if (!parsed.success) {
    throw createValidationError('message failed schema validation', {
      issues: parsed.error.issues,
    });
  }
}

export function ensureMessageSafe(message: Message): Message {
  assertMessageSafe(message);
  return deepFreeze(detachMutableValue(message));
}
