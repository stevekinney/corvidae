/**
 * Tells an agent's working narration apart from its answer.
 *
 * Narration has no marker in the stored data: an assistant's "Reading the ledger entries now" is a
 * text message like the final answer. It is told apart by position alone, inside Chat, so the wire
 * format and the stored transcript never change. A turn is the run of messages after a person's
 * message up to the next person's message. Tool activity is its own `tool-call` and `tool-result`
 * messages, so the rule reads across messages:
 *
 * - narration: assistant text that a tool message follows later in the same turn.
 * - answer: assistant text after the turn's last tool message. A turn with no tool messages has
 *   only an answer.
 *
 * - asking: narration that speaks to the person: no other assistant text sits between it and a
 *   pending approval, question or tool input (tool steps may). It keeps its message line, where
 *   bare narration has none. Once the person answers, it is plain narration.
 *
 * A streaming turn follows the same rule, which makes trailing text an answer until a tool message
 * follows it; at that moment it becomes narration.
 */

import type { Message } from '../conversation-model.ts';
import { getMessageText } from './utilities.ts';

/** What an assistant text message is within its turn. */
export type MessageTextRole = 'narration' | 'asking' | 'answer';

/** Options for {@link classifyAssistantText}. */
export type ClassifyAssistantTextOptions = {
  /**
   * Tool call ids the person has already answered in this chat (an approval decided or a question
   * answered) whose result has not yet stopped asking.
   */
  answeredCallIds?: ReadonlySet<string>;
};

/** Whether a message is tool activity the transcript shows: a call or a result that is not hidden. */
function isToolActivity(message: Message): boolean {
  return (message.role === 'tool-call' || message.role === 'tool-result') && !message.hidden;
}

/**
 * Classifies each assistant message that carries text as narration or answer.
 *
 * An assistant message with no text is left out: it has nothing to tell apart, and an empty
 * streaming placeholder is not an answer.
 *
 * @param messages - The transcript's messages in order
 * @param options - What the host knows beyond the messages
 * @returns The role of each assistant text message, keyed by message id
 */
export function classifyAssistantText(
  messages: readonly Message[],
  options: ClassifyAssistantTextOptions = {},
): ReadonlyMap<string, MessageTextRole> {
  const roles = new Map<string, MessageTextRole>();
  // The result that stands for a call is its last one: a decided approval's later result replaces
  // the one that asked.
  const lastResults = new Map<string, Message>();
  for (const message of messages) {
    if (message.role === 'tool-result' && message.toolResult) {
      lastResults.set(message.toolResult.callId, message);
    }
  }
  const isPendingAsk = (message: Message): boolean => {
    const result = message.toolResult;
    return (
      message.role === 'tool-result' &&
      !message.hidden &&
      result !== undefined &&
      result.outcome === 'action_required' &&
      (result.action?.type === 'approval' || result.action?.type === 'input') &&
      lastResults.get(result.callId) === message &&
      options.answeredCallIds?.has(result.callId) !== true
    );
  };
  // Walking backwards, a turn's tools are met before its text: whether one was seen since the
  // turn's closing person's message says whether the text above it is followed by a tool, and
  // whether a pending ask was seen since the later assistant text says it follows directly.
  let toolFollows = false;
  let askFollows = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === 'user') {
      toolFollows = false;
      askFollows = false;
    } else if (isToolActivity(message)) {
      toolFollows = true;
      if (isPendingAsk(message)) askFollows = true;
    } else if (
      message.role === 'assistant' &&
      !message.hidden &&
      getMessageText(message).trim().length > 0
    ) {
      roles.set(message.id, !toolFollows ? 'answer' : askFollows ? 'asking' : 'narration');
      askFollows = false;
    }
  }
  return roles;
}
