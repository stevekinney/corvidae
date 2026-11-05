import type { Conversation } from 'conversationalist';

/**
 * The metadata key a delivered session input's user turn carries its input id under. The turn's
 * own message id is that id too, unless the conversation already held a message with it.
 */
export const SESSION_INPUT_ID_METADATA_KEY = 'sessionInputId';

/** The metadata key a delivered session input's user turn carries its mailbox command under. */
export const SESSION_INPUT_COMMAND_ID_METADATA_KEY = 'sessionInputCommandId';

/**
 * The ids of the session inputs a step is about to answer: the user turns at the end of the
 * conversation that a session input gate appended, oldest first. A step boundary appends what it
 * delivers after everything already there, so the turns that end the conversation when a step
 * starts are the ones it took, at this boundary or at the late boundary of the step before it.
 * Any other message ends the run of them: earlier steps' inputs are behind a reply.
 */
export function stepSessionInputIds(conversation: Conversation): readonly string[] {
  const messages = conversation.getMessages({ includeHidden: true });
  const ids: string[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const id = message.metadata?.[SESSION_INPUT_ID_METADATA_KEY];
    if (message.role !== 'user' || typeof id !== 'string') break;
    ids.push(id);
  }
  return ids.toReversed();
}
