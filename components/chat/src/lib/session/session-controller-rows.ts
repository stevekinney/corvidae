import type { ConversationHistory } from '../components/chat/conversation-model.ts';

/**
 * Renames one row in place, keeping its position.
 *
 * The controller has to append an assistant placeholder before it has read a
 * single frame — that is what puts a row on screen while the response is
 * still opening. The host's own identifier for that row only arrives with
 * `assistant.step.started`. Renaming is what lets the two be the same row:
 * the alternative is to carry a client id alongside a server id and
 * reconcile them everywhere downstream, which is the mapping this avoids.
 *
 * Returns the history unchanged when there is nothing to do, so a caller can
 * use identity to decide whether anything happened. Refuses to overwrite an
 * existing row: a host that reuses an identifier is a host bug, and merging
 * two rows into one would lose the earlier one's content silently.
 */
export function remapMessageId(
  history: ConversationHistory,
  from: string,
  to: string,
): ConversationHistory {
  const original = history.messages[from];
  if (from === to || original === undefined || history.messages[to] !== undefined) return history;
  const messages = { ...history.messages, [to]: { ...original, id: to } };
  delete messages[from];
  return { ...history, ids: history.ids.map((id) => (id === from ? to : id)), messages };
}
