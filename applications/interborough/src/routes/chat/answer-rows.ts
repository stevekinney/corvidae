/**
 * The rows a person's answers to a run's questions become. The run appends its own row for an
 * answer, under the id `<runId>:signal:<signalName>:<ordinal>`, and the text it holds is what the
 * Bureau renders a delivered signal as (`renderSignalContinuation` in `@lostgradient/operative`):
 * `[signal:environment] "staging"` for the answer `staging`, `[signal:ready] true` for a yes.
 *
 * The page shows the answer in words, as the question's own "You answered" row does. The words come
 * from the question's schema when the page saw the question (`recordAnswer` in
 * `@lostgradient/chat`: a choice reads as its label, a secret as fixed words, never its value), and
 * otherwise from the payload alone: a string as the person typed it, anything else as plain text.
 * A rejection and a denial are shown as they are.
 */
import { recordAnswer, type ConversationHistory } from '@lostgradient/chat';

/** `<runId>:signal:<signalName>:<ordinal>`: the signal's name is what lies between the last `:signal:` and the ordinal. */
const ANSWER_ROW_IDENTIFIER = /^(.+):signal:(.+):(\d+)$/s;

/** The prefix of an interrupt the run parks a question on: `human-wait:<runId>:<signalName>:<ordinal>`. */
const QUESTION_PREFIX = 'human-wait:';

/** The key the question of `interruptId` and the answer row it becomes share, or `undefined` for any other interrupt. */
export function questionKeyOf(interruptId: string): string | undefined {
  return interruptId.startsWith(QUESTION_PREFIX)
    ? interruptId.slice(QUESTION_PREFIX.length)
    : undefined;
}

/** The key an answer row's id shares with its question's interrupt, or `undefined` for any other row. */
function answerKeyOf(id: string): string | undefined {
  const match = ANSWER_ROW_IDENTIFIER.exec(id);
  return match === null ? undefined : `${match[1]}:${match[2]}:${match[3]}`;
}

/** A payload the Bureau renders as a rejection or a denial, which the page shows as rendered. */
function isRefusalPayload(payload: unknown): boolean {
  return (
    isRecordValue(payload) &&
    (Object.hasOwn(payload, '__abRejected') || Object.hasOwn(payload, '__abDenied'))
  );
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `payload` as plain text when no schema says more about it. */
function plainText(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  if (Array.isArray(payload)) return (payload as unknown[]).map(plainText).join(', ');
  if (isRecordValue(payload)) {
    return Object.entries(payload)
      .map(([key, entry]) => `${key}: ${plainText(entry)}`)
      .join(', ');
  }
  return JSON.stringify(payload) ?? '';
}

/**
 * The answer the row `id` holds as `content`, in words, or `undefined` for any other row, and for a
 * rejection or denial. `schemaOf` finds the schema of the question the row answers, by their shared key.
 */
export function typedAnswerOf(
  id: string,
  content: unknown,
  schemaOf?: (key: string) => Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  if (typeof content !== 'string') return undefined;
  const match = ANSWER_ROW_IDENTIFIER.exec(id);
  const signalName = match?.[2];
  if (signalName === undefined) return undefined;
  const prefix = `[signal:${signalName}] `;
  if (!content.startsWith(prefix)) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(content.slice(prefix.length));
  } catch {
    return undefined;
  }
  if (isRefusalPayload(payload)) return undefined;
  const key = answerKeyOf(id);
  const schema = key === undefined ? undefined : schemaOf?.(key);
  if (schema !== undefined) {
    return recordAnswer({
      toolCallId: id,
      toolName: signalName,
      message: undefined,
      schema,
      value: payload,
    }).summary;
  }
  return plainText(payload);
}

/** The conversation with each delivered answer's row showing the answer in words. */
export function withTypedAnswers(
  conversation: ConversationHistory,
  schemaOf?: (key: string) => Readonly<Record<string, unknown>> | undefined,
): ConversationHistory {
  let messages: Record<string, ConversationHistory['messages'][string]> | undefined;
  for (const id of conversation.ids) {
    const message = conversation.messages[id];
    if (message === undefined || message.role !== 'user') continue;
    const typed = typedAnswerOf(id, message.content, schemaOf);
    if (typed === undefined) continue;
    messages ??= { ...conversation.messages };
    messages[id] = { ...message, content: typed };
  }
  return messages === undefined ? conversation : { ...conversation, messages };
}
