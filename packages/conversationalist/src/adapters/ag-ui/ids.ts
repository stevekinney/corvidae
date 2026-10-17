/**
 * Message identity across the AG-UI boundary.
 *
 * An AG-UI message keeps its `id` as the Conversationalist message `id`, so a
 * client that holds both histories can tell they describe the same message. A
 * message that splits into several Conversationalist messages derives the ids
 * of the extra rows from its own, and export reads the derivation back:
 *
 * - an assistant message with text (or reasoning) and `toolCalls` becomes a
 *   text row with the message's `id` and a `tool-call` row per call, with id
 *   `<id>:call:<toolCall.id>`;
 * - an assistant message with only `toolCalls` gives its first call the
 *   message's `id` and derives the rest the same way;
 * - the reasoning messages before an assistant message are not rows: they
 *   become `thinking` parts of it, and export writes them back as messages
 *   with id `<id>:reasoning:<n>`.
 */

/** Joins an assistant message id to the id of one of its tool-call rows. */
export const CALL_ID_SEPARATOR = ':call:';

/** Joins an assistant message id to the id of the n-th reasoning message before it. */
export const REASONING_ID_SEPARATOR = ':reasoning:';

/** The id of the `tool-call` row for one call of an assistant message. */
export function callRowId(messageId: string, toolCallId: string): string {
  return `${messageId}${CALL_ID_SEPARATOR}${toolCallId}`;
}

/**
 * The assistant message id a tool-call row's id was derived from, or
 * `undefined` for a row whose id stands on its own.
 */
export function callRowParent(rowId: string, toolCallId: string): string | undefined {
  const suffix = `${CALL_ID_SEPARATOR}${toolCallId}`;
  return rowId.endsWith(suffix) && rowId.length > suffix.length
    ? rowId.slice(0, -suffix.length)
    : undefined;
}
