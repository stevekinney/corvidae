import { isFollowUpMessage } from '../components/chat/builders.ts';
import type { ConversationHistory } from '../components/chat/conversation-model.ts';
import { getOwn } from '../utilities/get-own.ts';

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
  const original = getOwn(history.messages, from);
  if (from === to || original === undefined || getOwn(history.messages, to) !== undefined)
    return history;
  const messages = { ...history.messages, [to]: { ...original, id: to } };
  delete messages[from];
  return { ...history, ids: history.ids.map((id) => (id === from ? to : id)), messages };
}

/**
 * Reconciles a run's provisional rows against the authoritative history its
 * terminal frame carried.
 *
 * This is NOT the same operation as adopting a full session snapshot, and
 * the difference is the whole point. A full snapshot replaces membership: the
 * host asked for the conversation and got all of it. A run terminal is
 * narrower — it is authoritative about the rows THIS RUN produced and says
 * nothing about anything else. So the merge replaces only what the run
 * appended and leaves every other row exactly where it was, including turns
 * that arrived from elsewhere while the run was streaming.
 *
 * The canonical rows go back in at the position the first provisional row
 * occupied, not at the end, so a turn that was in the middle of the
 * transcript stays in the middle.
 *
 * The one row that is both provisional and already-accepted history is the
 * user turn that opened the run. When the terminal names it under the same
 * identifier, it is kept rather than deleted and reinserted: approval
 * resolution associates a tool call with the turn that owns it by identifier,
 * and swapping that identifier mid-run would orphan a pending approval.
 *
 * One exception to "rows the run did not append stay where they are": a row
 * added after the run started, which the terminal names under its own
 * identifier, moves to the position the terminal gives it. For a follow-up the
 * client's object wins.
 */
export function mergeRunHistory(
  current: ConversationHistory,
  terminal: ConversationHistory,
  provisionalIds: ReadonlySet<string>,
  runStartIds: ReadonlySet<string>,
): ConversationHistory {
  const messages = { ...current.messages };
  // Every row that was already on screen when the run started AND that the
  // terminal names under the same identifier. Those keep the CLIENT's message
  // object, not the server's: a prior turn may carry local decoration — a
  // delivery-failure marker, an unsaved-turn annotation — that the server has
  // no idea about and would silently strip if its copy won.
  const retained = new Set(
    [...runStartIds].filter((id) => getOwn(terminal.messages, id) !== undefined),
  );
  // The one exception to "rows the run did not append stay where they are": a
  // row that arrived after the run started and that the terminal names under its
  // own identifier moves to the position the terminal gives it, so the
  // transcript keeps a single row in the order the server saw. That is a
  // follow-up the user sent mid-run, and also a row an opening snapshot
  // installed on a page that joined the run: that row is not provisional, so
  // leaving it where it is would put the terminal's rows after it and a
  // follow-up before them. A row the terminal omits stays where it is. The
  // client's object wins for a follow-up, so its marker and delivery status
  // survive.
  const relocated = new Set(
    current.ids.filter(
      (id) =>
        getOwn(terminal.messages, id) !== undefined &&
        // Only a row added after this run started: an earlier run's rows were
        // already on screen, so they stay where they are.
        !runStartIds.has(id),
    ),
  );
  const isRemoved = (id: string): boolean =>
    (provisionalIds.has(id) && !retained.has(id)) || relocated.has(id);
  const firstProvisional = current.ids.findIndex(
    (id) => provisionalIds.has(id) && !retained.has(id),
  );
  const insertionIndex =
    firstProvisional === -1
      ? current.ids.length
      : current.ids.slice(0, firstProvisional).filter((id) => !isRemoved(id)).length;
  const ids = current.ids.filter((id) => !isRemoved(id));
  for (const id of provisionalIds) {
    if (!retained.has(id)) delete messages[id];
  }
  const canonicalIds = terminal.ids.filter((id) => !retained.has(id));
  for (const id of canonicalIds) {
    const message = isFollowUpMessage(getOwn(current.messages, id))
      ? getOwn(current.messages, id)
      : getOwn(terminal.messages, id);
    if (message !== undefined) messages[id] = message;
  }
  ids.splice(
    Math.min(insertionIndex, ids.length),
    0,
    ...canonicalIds.filter((id) => !ids.includes(id)),
  );
  return { ...current, ids, messages };
}

/**
 * Puts follow-ups back after a run rolls the transcript back to its last
 * committed snapshot.
 *
 * A failed run restores the history it captured earlier, which predates any
 * follow-up the user sent while it was working. Those rows were never the run's
 * to discard — the transport may already have them — so every row marked as a
 * follow-up is carried over from what is on screen, in its current order and
 * with its delivery state.
 */
export function restoreFollowUps(
  rolledBack: ConversationHistory,
  current: ConversationHistory,
): ConversationHistory {
  const missing = current.ids.filter(
    (id) =>
      isFollowUpMessage(getOwn(current.messages, id)) &&
      getOwn(rolledBack.messages, id) === undefined,
  );
  if (missing.length === 0) return rolledBack;
  const messages = { ...rolledBack.messages };
  for (const id of missing) {
    const message = getOwn(current.messages, id);
    if (message !== undefined) messages[id] = message;
  }
  return { ...rolledBack, ids: [...rolledBack.ids, ...missing], messages };
}
