/**
 * The message-metadata keys only the Bureau may set on a conversation row (COR-1546, COR-2437).
 * A client's message carries whatever `metadata` it sends, so every row that enters from a client
 * is stored without them (`http/ag-ui-messages.ts`, `withoutReservedMetadata`):
 *
 * - `memoryEvidence` marks the row a run's memory recall appended, which the thread hides while the
 *   model reads it;
 * - `conversationalist:modelOnly` marks a row the model is sent and people are never shown, so a
 *   client's row carrying it would be answered while hidden from the person;
 * - the continuation keys name a resumed turn's hidden row and its instruction turn, so a client's
 *   row carrying one would read as the Bureau's and be removed with a discard.
 *
 * A key the Bureau starts setting on rows is added here, and the tests strip each.
 *
 * @module reserved-message-metadata
 */

import { MEMORY_EVIDENCE_METADATA_KEY } from '@lostgradient/operative';
import { MODEL_ONLY_METADATA_KEY } from 'conversationalist';

import {
  CONTINUATION_COMMAND_METADATA_KEY,
  CONTINUATION_INSTRUCTION_OF_METADATA_KEY,
  CONTINUATION_OF_METADATA_KEY,
  CONTINUATION_OWNER_METADATA_KEY,
} from './session-resume';

/** Every message-metadata key only the Bureau may set. */
export const RESERVED_MESSAGE_METADATA_KEYS: ReadonlySet<string> = new Set([
  MEMORY_EVIDENCE_METADATA_KEY,
  MODEL_ONLY_METADATA_KEY,
  CONTINUATION_OF_METADATA_KEY,
  CONTINUATION_COMMAND_METADATA_KEY,
  CONTINUATION_OWNER_METADATA_KEY,
  CONTINUATION_INSTRUCTION_OF_METADATA_KEY,
]);

/** `metadata` without the keys only the Bureau may set, or the same object when it holds none. */
export function withoutReservedMessageMetadata<T extends Readonly<Record<string, unknown>>>(
  metadata: T,
): T {
  if (!Object.keys(metadata).some((key) => RESERVED_MESSAGE_METADATA_KEYS.has(key)))
    return metadata;
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !RESERVED_MESSAGE_METADATA_KEYS.has(key)),
  ) as T;
}
