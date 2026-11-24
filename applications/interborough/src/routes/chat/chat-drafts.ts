/**
 * The draft store: what the person typed in a chat's composer and has not sent, kept in this
 * browser so a chat opened again puts it back with when it was written (COR-2284 C7, Chat's
 * draft-restored drawer).
 *
 * Each chat's draft is one entry of the workspace's `localStorage` view (`workspace-lifetime.ts`),
 * under `chat-draft:<session id>`, holding `{"text": string, "savedAt": number}` (milliseconds since
 * the epoch). An empty entry, one that does not parse, or one with no text is no draft. Sending the
 * draft, emptying the box, or Discard draft writes the entry empty.
 */
import { rowTime, viewerTimeZone } from '../../lib/format/clock.ts';

/** A draft the store holds. */
export interface ChatDraft {
  /** What the person typed. */
  readonly text: string;
  /** When it was last written, in milliseconds since the epoch. */
  readonly savedAt: number;
}

/** The storage the store writes to: the workspace's `localStorage` view, or a stand-in in a test. */
export type DraftStorage = Pick<Storage, 'getItem' | 'setItem'>;

const keyOf = (sessionId: string): string => `chat-draft:${sessionId}`;

/** The draft kept for `sessionId`, or `undefined` when there is none. */
export function readChatDraft(storage: DraftStorage, sessionId: string): ChatDraft | undefined {
  let raw: string | null;
  try {
    raw = storage.getItem(keyOf(sessionId));
  } catch {
    return undefined;
  }
  if (raw === null || raw === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const text: unknown = Object.hasOwn(parsed, 'text') ? Reflect.get(parsed, 'text') : undefined;
  const savedAt: unknown = Object.hasOwn(parsed, 'savedAt')
    ? Reflect.get(parsed, 'savedAt')
    : undefined;
  if (typeof text !== 'string' || text.trim() === '') return undefined;
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) return undefined;
  return { text, savedAt };
}

/** Keeps `text` as the draft of `sessionId`, written at `now`; an empty text forgets the draft. */
export function writeChatDraft(
  storage: DraftStorage,
  sessionId: string,
  text: string,
  now: number,
): void {
  const value = text.trim() === '' ? '' : JSON.stringify({ text, savedAt: now });
  try {
    storage.setItem(keyOf(sessionId), value);
  } catch {
    // A full or blocked storage keeps no draft; the composer still holds the text.
  }
}

/** Forgets the draft of `sessionId`. */
export function forgetChatDraft(storage: DraftStorage, sessionId: string): void {
  writeChatDraft(storage, sessionId, '', 0);
}

/**
 * When a draft was written, as the draft-restored drawer says it after "from": the clock alone for
 * today ("10:42 AM"), "yesterday at 4:12 PM", and the day and clock for anything older
 * ("Thu, Oct 29, 4:12 PM").
 */
export function draftTime(savedAt: number, now: number, zone: string = viewerTimeZone()): string {
  const words = rowTime(savedAt, now, zone);
  return words.startsWith('Yesterday, ') ? `yesterday at ${words.slice(11)}` : words;
}
