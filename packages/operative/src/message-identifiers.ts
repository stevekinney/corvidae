/**
 * Deterministic ids for the conversation rows a run commits.
 *
 * A client that follows a run over a streaming protocol names every message it
 * shows by id, and a snapshot of the conversation taken later must carry the
 * same ids, or the client shows each row twice. Minting ids at random cannot
 * give that, so a run that has an id derives them from it:
 *
 * - the assistant text of step `n` is `<runId>:step:<n>`;
 * - the `tool-call` row for call `c` of that step is `<assistantId>:call:<c>`,
 *   the id Conversationalist's AG-UI mapping reads back as a call of that
 *   message. A step with no text row gives its first call the step's own id
 *   instead, which is how the same mapping reads an assistant message that has
 *   calls and no text;
 * - the `tool-result` row for call `c` of step `n` is `<runId>:step:<n>:result:<c>`;
 * - the `user` row a delivered human-wait signal appends is
 *   `<runId>:signal:<signalName>:<n>`, `n` counting the run's human-wait parks
 *   from zero, so a client that watched the run resume shows the answer under
 *   the id a later snapshot holds it by.
 *
 * A run without an id (a bare `executeLoop` call) mints ids as it always did.
 *
 * @module message-identifiers
 */

import { type Conversation, withMessageId } from 'conversationalist';

/** The id of the assistant text row of `step`, or `undefined` for a run with no id. */
export function assistantMessageIdentifier(
  runId: string | undefined,
  step: number,
): string | undefined {
  return runId === undefined ? undefined : `${runId}:step:${step}`;
}

/** The id of the `tool-result` row for `callId` in `step`, or `undefined` for a run with no id. */
export function toolResultMessageIdentifier(
  runId: string | undefined,
  step: number,
  callId: string,
): string | undefined {
  return runId === undefined ? undefined : `${runId}:step:${step}:result:${callId}`;
}

/**
 * The ids of the `tool-call` rows for `calls`, in order, or `undefined` when the
 * step has no assistant id. `assistantRowExists` says whether the step committed
 * an assistant text row under that id.
 */
export function toolCallMessageIdentifiers(
  assistantId: string | undefined,
  calls: ReadonlyArray<{ readonly id: string }>,
  assistantRowExists: boolean,
): string[] | undefined {
  if (assistantId === undefined) return undefined;
  return calls.map((call, index) =>
    index === 0 && !assistantRowExists ? assistantId : `${assistantId}:call:${call.id}`,
  );
}

/**
 * Appends the assistant text a run's `onMaximumSteps` handler returned, under the
 * id of the step after the last one (`step`), or minted when the run has no id.
 */
export function appendFinalAssistantMessage(
  conversation: Conversation,
  content: string,
  runId: string | undefined,
  step: number,
): void {
  const id = assistantMessageIdentifier(runId, step);
  if (id === undefined) {
    conversation.appendAssistantMessage(content);
    return;
  }
  conversation.appendMessages(withMessageId({ role: 'assistant', content }, id));
}

/**
 * The id a step's assistant row may be appended under on this attempt.
 *
 * A step that is retried (an `onError` hook answering `'retry'` after the model
 * call already finalized its row) would append a second row under the step's id,
 * which the conversation refuses. The earlier attempt's row is the last in the
 * conversation, because nothing after generation has run, so it is taken out
 * and the retry's row replaces it: the rejected response is not part of the
 * history the client is shown. A row under that id anywhere else is a broken
 * invariant (nothing but the retried step appends under it), and fails loudly
 * rather than minting an id the client could not match.
 */
export function assistantRowIdentifierForAttempt(
  conversation: Conversation,
  id: string | undefined,
): string | undefined {
  if (id === undefined) return undefined;
  const rows = conversation.getMessages({ includeHidden: true });
  const held = rows.findIndex((row) => row.id === id);
  if (held === -1) return id;
  if (held !== rows.length - 1) {
    throw new Error(
      `Row "${id}" is already in the conversation and is not its last row, so a retried step cannot replace it`,
    );
  }
  conversation.rewindBeforeMessage(id);
  return id;
}

/**
 * The id of the row the `ordinal`th human-wait delivery of a run appends, or
 * `undefined` for a run with no id. The ordinal counts the run's human-wait parks
 * from zero (the same count the park's review id carries), so it only grows: a
 * conversation that is compacted afterwards cannot make a later delivery reuse an
 * id, and a client that is told the park knows the id before the answer lands.
 */
export function signalMessageIdentifier(
  runId: string | undefined,
  signalName: string,
  ordinal: number,
): string | undefined {
  return runId === undefined ? undefined : `${runId}:signal:${signalName}:${ordinal}`;
}
