/**
 * The rows a person's answers to a run's questions become. The run appends its own row for an
 * answer, under the id `<runId>:signal:<signalName>:<ordinal>`, and the text it holds is what the
 * Bureau renders a delivered signal as (`renderSignalContinuation` in `@lostgradient/operative`):
 * `[signal:environment] "staging"` for the answer `staging`. The page shows the answer as the
 * person typed it.
 *
 * Only that one form is shown as the typed text: the row's id names a signal and a park, and its
 * text is the delivered form with a JSON string for its payload. A rejection, a denial, and a
 * payload that is not a string (a client other than this page answered) are shown as they are.
 */
import type { ConversationHistory } from '@lostgradient/chat';

/** `<runId>:signal:<signalName>:<ordinal>`: the signal's name is what lies between the last `:signal:` and the ordinal. */
const ANSWER_ROW_IDENTIFIER = /^.+:signal:(.+):\d+$/s;

/** The text the person typed for the answer row `id` holds as `content`, or `undefined` for any other row. */
export function typedAnswerOf(id: string, content: unknown): string | undefined {
  if (typeof content !== 'string') return undefined;
  const signalName = ANSWER_ROW_IDENTIFIER.exec(id)?.[1];
  if (signalName === undefined) return undefined;
  const prefix = `[signal:${signalName}] `;
  if (!content.startsWith(prefix)) return undefined;
  try {
    const payload: unknown = JSON.parse(content.slice(prefix.length));
    return typeof payload === 'string' ? payload : undefined;
  } catch {
    return undefined;
  }
}

/** The conversation with each delivered answer's row showing the text that was typed. */
export function withTypedAnswers(conversation: ConversationHistory): ConversationHistory {
  let messages: Record<string, ConversationHistory['messages'][string]> | undefined;
  for (const id of conversation.ids) {
    const message = conversation.messages[id];
    if (message === undefined || message.role !== 'user') continue;
    const typed = typedAnswerOf(id, message.content);
    if (typed === undefined) continue;
    messages ??= { ...conversation.messages };
    messages[id] = { ...message, content: typed };
  }
  return messages === undefined ? conversation : { ...conversation, messages };
}
