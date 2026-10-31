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
 * narrower — it is authoritative about the rows it names and says nothing
 * about anything else. So the merge drops only what the run appended and
 * leaves every row the terminal omits where it was, including turns that
 * arrived from elsewhere while the run was streaming.
 *
 * The rule: every row the terminal names takes the terminal's position; a row
 * the terminal does not name keeps its place among them, following the nearest
 * row before it on screen that the terminal names, and sitting before the
 * terminal's rows there if it was on screen before the run's own rows, after
 * them otherwise; a provisional row the terminal does not name is dropped.
 *
 * The terminal's order is the thread's order, so it decides the position of
 * every row it names, whichever side appended the row and whenever it arrived:
 * the run's own replies, a follow-up the user sent mid-run, a row an opening
 * snapshot installed on a page that joined the run or resumed it, and a turn a
 * second tab or a schedule added that the page never read. A rule that moved
 * only some of these rows had to reinsert them at one point, which misplaced
 * whichever row that point was not for (COR-1555, COR-1958).
 *
 * Which object a row keeps is a separate question from where it sits. A row
 * that was already on screen when the run started and that the terminal names
 * under the same identifier keeps the CLIENT's object: a prior turn may carry
 * local decoration — a delivery-failure marker, an unsaved-turn annotation —
 * that the server has no idea about and would silently strip if its copy won.
 * That includes the user turn that opened the run: approval resolution
 * associates a tool call with the turn that owns it by identifier, and
 * swapping that identifier mid-run would orphan a pending approval. A follow-up
 * keeps the client's object too, so its marker and delivery status survive.
 * Every other row the terminal names takes the terminal's object, including a row the run
 * started with that this page no longer holds.
 */
export function mergeRunHistory(
  current: ConversationHistory,
  terminal: ConversationHistory,
  provisionalIds: ReadonlySet<string>,
  runStartIds: ReadonlySet<string>,
): ConversationHistory {
  const named = (id: string): boolean => getOwn(terminal.messages, id) !== undefined;
  const retained = new Set([...runStartIds].filter(named));
  const dropped = (id: string): boolean => provisionalIds.has(id) && !retained.has(id);
  // Where the run's own rows were on screen: the terminal's rows take their
  // place among the rows it does not name. With none on screen (a page that
  // joined the run has only the thread's rows), every unnamed row sat before
  // them.
  const ownRowsAt = current.ids.findIndex(dropped);
  // The rows the terminal does not name, by the named row each follows on
  // screen (`undefined` for a row before any), split by which side of the run's
  // own rows it sat on.
  const before = new Map<string | undefined, string[]>();
  const after = new Map<string | undefined, string[]>();
  let anchor: string | undefined;
  current.ids.forEach((id, index) => {
    if (dropped(id)) return;
    if (named(id)) {
      anchor = id;
      return;
    }
    const side = ownRowsAt === -1 || index < ownRowsAt ? before : after;
    side.set(anchor, [...(side.get(anchor) ?? []), id]);
  });
  const onScreen = new Set(current.ids.filter((id) => !dropped(id)));
  const ids = [...(before.get(undefined) ?? [])];
  anchor = undefined;
  for (const id of terminal.ids) {
    if (onScreen.has(id)) {
      ids.push(...(after.get(anchor) ?? []));
      anchor = id;
      ids.push(id, ...(before.get(id) ?? []));
    } else {
      ids.push(id);
    }
  }
  ids.push(...(after.get(anchor) ?? []));
  const messages = { ...current.messages };
  for (const id of provisionalIds) {
    if (!retained.has(id)) delete messages[id];
  }
  for (const id of terminal.ids) {
    if (retained.has(id) && getOwn(current.messages, id) !== undefined) continue;
    const message = isFollowUpMessage(getOwn(current.messages, id))
      ? getOwn(current.messages, id)
      : getOwn(terminal.messages, id);
    if (message !== undefined) messages[id] = message;
  }
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
