import { type Conversation, type MultiModalContent, withMessageId } from 'conversationalist';

import { assistantRowIdentifierForAttempt } from './message-identifiers';

import { rowContentForParts } from './response-parts';
import type { JSONValue } from './types';

/** What {@link commitAssistantRow} did. */
export interface CommittedRow {
  /** The id of the assistant row the step ended with; `undefined` when it committed none. */
  readonly messageId: string | undefined;
}

/**
 * Commits a step's settled parts as its assistant row and returns the row's id.
 *
 * The row is appended whenever the parts are non-empty, not whenever the text is: a response that
 * is a thinking block followed by a tool call has no text and still has a row to keep. A row that
 * is exactly one plain text part keeps the string shorthand; any other parts are stored as an
 * array, so a part's index is its position in the row's content.
 *
 * When a streaming wrapper already wrote the step's row (`streamedRowId`), that row stays if it
 * already holds the settled parts. If a hook changed the response after the wrapper committed it
 * (an output guardrail redacting, a `validateResponse` hook swapping the text), the streamed row is
 * stale and carries exactly what the hook meant to remove, so the loop rewinds to it and appends
 * the settled parts in its place. The row is the last one at this point (tools have not run), so the
 * rewind removes nothing else; a `streamedRowId` that is not the tail is not this step's row and is
 * ignored.
 */
export function commitAssistantRow(input: {
  readonly conversation: Conversation;
  readonly parts: readonly MultiModalContent[];
  readonly metadata: Record<string, JSONValue> | undefined;
  readonly streamedRowId: string | undefined;
  /** The id the row is committed under for a run that has an id; `undefined` mints one. */
  readonly rowId: string | undefined;
}): CommittedRow {
  const { conversation, parts, metadata, streamedRowId, rowId } = input;
  const content = parts.length === 0 ? undefined : rowContentForParts(parts);

  // Only the current attempt's own tail row can be reconciled. A response that names an earlier row
  // (a cached streamed response replayed in a later turn) did not write one this step: rewinding to
  // it would delete every turn after it, so it is treated as a response with no row of its own and
  // the settled parts are appended fresh.
  const streamedIsTail =
    streamedRowId !== undefined && conversation.current.ids.at(-1) === streamedRowId;
  if (streamedRowId !== undefined && streamedIsTail) {
    const streamed = conversation.current.messages[streamedRowId];
    if (streamed !== undefined) {
      if (content !== undefined && JSON.stringify(streamed.content) === JSON.stringify(content)) {
        return { messageId: streamedRowId };
      }
      conversation.rewindBeforeMessage(streamedRowId);
    }
  }

  if (content === undefined) return { messageId: undefined };
  // A retried step replaces its earlier attempt's row under the same id.
  const id = assistantRowIdentifierForAttempt(conversation, rowId);
  conversation.appendMessages(
    id === undefined
      ? { role: 'assistant', content, metadata }
      : withMessageId({ role: 'assistant', content, metadata }, id),
  );
  return { messageId: conversation.current.ids.at(-1) };
}
