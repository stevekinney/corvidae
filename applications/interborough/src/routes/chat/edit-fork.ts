import type { ConversationHistory } from '@lostgradient/chat';

/**
 * Where a message the person sent can be edited from. Editing resends by fork: the chat is branched
 * at the reply before the message (`bureau.contexts.fork`), or before its first message, and the
 * edited text is sent on the branch. The Bureau branches only after the final reply of a finished
 * run (`branch-points.ts`), so the message must be the first one, or follow such a reply.
 *
 * Answers the message to branch through, `null` to branch before the first message, or `undefined`
 * when the message is unknown, is not one the person sent, or was sent while a run was going and so
 * follows no finished reply. Hidden rows, which the page keeps for its own reading, do not count as
 * what precedes it.
 */
export function editForkPoint(
  conversation: ConversationHistory,
  messageId: string,
  branchPoints: ReadonlySet<string>,
): string | null | undefined {
  const visible = conversation.ids.flatMap((id) => {
    const message = conversation.messages[id];
    return message === undefined || message.hidden ? [] : [message];
  });
  const index = visible.findIndex((message) => message.id === messageId);
  if (index === -1 || visible[index]?.role !== 'user') return undefined;
  const before = visible[index - 1];
  if (before === undefined) return null;
  return branchPoints.has(before.id) ? before.id : undefined;
}

/** The last message a branch can be made from, or `undefined` when the chat offers none. */
export function lastBranchPoint(
  conversation: ConversationHistory,
  branchPoints: ReadonlySet<string>,
): string | undefined {
  return conversation.ids.findLast((id) => branchPoints.has(id));
}

/**
 * The edited text of messages whose branch has been made and not yet opened, by the branch's
 * session. The branch is a page of its own, and the text goes with the person to it in memory, not
 * in the address, so it is not in a history entry or a shared link. The page that opens the branch
 * sends it once and removes it.
 */
const pending = new Map<string, string>();

/** Keeps the edited text for the branch `sessionId` until its page opens. */
export function holdEdit(sessionId: string, content: string): void {
  pending.set(sessionId, content);
}

/** Takes the edited text held for `sessionId`, if any; it is held no longer. */
export function takeEdit(sessionId: string): string | undefined {
  const content = pending.get(sessionId);
  pending.delete(sessionId);
  return content;
}
