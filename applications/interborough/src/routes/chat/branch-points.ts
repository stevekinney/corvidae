import type { ConversationHistory } from '@lostgradient/chat';

/**
 * The messages a conversation offers to branch from: the final agent message of each completed
 * turn. That is an assistant message followed by a user message, or the last message while no run
 * is active. A turn's earlier assistant messages are followed by tool results, so they are not
 * offered. Hidden rows, which the page puts in the conversation for its own reading, are not
 * messages a person sees and do not count as what follows. The Bureau still decides whether a
 * message is a branch point (`bureau.contexts.fork`), so this only keeps the action to where a
 * branch can be made.
 */
export function branchPointIds(
  conversation: ConversationHistory,
  runActive: boolean,
): ReadonlySet<string> {
  const visible = conversation.ids.flatMap((id) => {
    const message = conversation.messages[id];
    return message === undefined || message.hidden ? [] : [message];
  });
  const offered = new Set<string>();
  visible.forEach((message, index) => {
    if (message.role !== 'assistant') return;
    const next = visible[index + 1];
    if (next === undefined ? !runActive : next.role === 'user') offered.add(message.id);
  });
  return offered;
}
