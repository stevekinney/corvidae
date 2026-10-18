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
 * - the `tool-result` row for call `c` of step `n` is `<runId>:step:<n>:result:<c>`.
 *
 * A run without an id (a bare `executeLoop` call) mints ids as it always did.
 *
 * @module message-identifiers
 */

import type { Conversation, MessageInput } from 'conversationalist';

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
  const row: MessageInput & { readonly id: string } = { id, role: 'assistant', content };
  conversation.appendMessages(row);
}
