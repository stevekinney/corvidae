/**
 * The time a row says it was written is the Bureau's record of it (`conversationalist:createdAt`
 * on the message). A message the Bureau recorded no time for, such as a reply cut short when the
 * server stopped, has none to show: reading it in would stamp it with the moment of the read, which
 * would put "10:46 AM" under it, open a day band for today above the older messages, and date a
 * reply that was written days ago as if it had just arrived.
 */
import type { ConversationHistory } from '@lostgradient/chat';
import { CREATED_AT_METADATA_KEY } from 'conversationalist';

/** What a row's `createdAt` holds when no time was recorded: the transcript shows no time for it. */
export const NO_RECORDED_TIME = '';

/** Whether `holder`'s own metadata records a time that parses as a date. */
function holdsTime(holder: unknown): boolean {
  if (typeof holder !== 'object' || holder === null) return false;
  const metadata: unknown = Reflect.get(holder, 'metadata');
  if (typeof metadata !== 'object' || metadata === null) return false;
  const value: unknown = Reflect.get(metadata, CREATED_AT_METADATA_KEY);
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/**
 * Whether the row that stands under `message`'s id has a recorded time: the message's own, or, for
 * a step that only called tools (its first call's row takes the message's id), the first call's.
 */
function recordsTime(message: unknown): boolean {
  if (holdsTime(message)) return true;
  const calls: unknown =
    typeof message === 'object' && message !== null ? Reflect.get(message, 'toolCalls') : undefined;
  return Array.isArray(calls) && holdsTime(calls[0]);
}

/**
 * `conversation` with the time of the import taken off every row whose message (of `messages`, the
 * thread as the Bureau sent it) recorded none. A message that split into several rows keeps the
 * times its calls recorded: only the row that stands under the message's own id is cleared.
 */
export function withoutImportTimes(
  conversation: ConversationHistory,
  messages: readonly unknown[],
): ConversationHistory {
  const unrecorded = messages.flatMap((message) => {
    const id: unknown =
      typeof message === 'object' && message !== null ? Reflect.get(message, 'id') : undefined;
    return typeof id === 'string' && !recordsTime(message) ? [id] : [];
  });
  const cleared = unrecorded.filter((id) => {
    const row = conversation.messages[id];
    return row !== undefined && row.createdAt !== NO_RECORDED_TIME;
  });
  if (cleared.length === 0) return conversation;
  const rows = { ...conversation.messages };
  for (const id of cleared) {
    const row = rows[id];
    if (row !== undefined) rows[id] = { ...row, createdAt: NO_RECORDED_TIME };
  }
  return { ...conversation, messages: rows };
}
