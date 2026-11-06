import type { ConversationHistory } from '@lostgradient/chat';

/**
 * Where a message the person sent can be branched from: the chat is branched at the reply before
 * the message (`bureau.contexts.fork`), or before its first message, and the person types again
 * there. The Bureau branches only after the final reply of a finished
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
  // The agent's instructions open the transcript but are not part of what was said, so they do not
  // count as what precedes the first message.
  const visible = conversation.ids.flatMap((id) => {
    const message = conversation.messages[id];
    return message === undefined || message.hidden || message.role === 'system' ? [] : [message];
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
