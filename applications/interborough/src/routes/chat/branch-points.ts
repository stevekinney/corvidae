import type { ConversationHistory } from '@lostgradient/chat';

/** The Bureau names the assistant row of a run's step `<runId>:step:<n>`. */
const STEP_ROW = /^(.+):step:\d+$/;

/** The run a step row belongs to, or `undefined` for a row that is not named as one. */
function runOf(id: string): string | undefined {
  return STEP_ROW.exec(id)?.[1];
}

/**
 * The messages a conversation offers to branch from: the final agent message of each completed
 * turn.
 *
 * A row the Bureau names as a step (`<runId>:step:<n>`) is offered only when it is the last row of
 * its run in the transcript, because a follow-up delivered to a run in flight puts a user row
 * between two steps of one run, and the Bureau branches only from a run's final step. While a run is
 * going, nothing is offered: the run's reply is still being written (its live row carries an id the
 * page made up, not the Bureau's), so which rows are the run's cannot be told from the rows alone,
 * and a branch is offered after the reply is complete.
 *
 * A row with any other id falls back to the plain rule: an agent message followed by a user message.
 * A turn's earlier agent messages are followed by tool
 * results, so they are not offered. Hidden rows, which the page puts in the conversation for its own
 * reading, are not messages a person sees and do not count as what follows. The Bureau still decides
 * whether a message is a branch point (`bureau.contexts.fork`), so this only keeps the action to
 * where a branch can be made.
 */
export function branchPointIds(
  conversation: ConversationHistory,
  runActive: boolean,
): ReadonlySet<string> {
  if (runActive) return new Set();
  const visible = conversation.ids.flatMap((id) => {
    const message = conversation.messages[id];
    return message === undefined || message.hidden ? [] : [message];
  });
  const offered = new Set<string>();
  visible.forEach((message, index) => {
    if (message.role !== 'assistant') return;
    const run = runOf(message.id);
    if (run === undefined) {
      const next = visible[index + 1];
      if (next === undefined || next.role === 'user') offered.add(message.id);
      return;
    }
    const prefix = `${run}:step:`;
    if (visible.slice(index + 1).some((later) => later.id.startsWith(prefix))) return;
    offered.add(message.id);
  });
  return offered;
}
