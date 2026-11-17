/**
 * The draft store: what the person typed in a chat's composer and has not sent, kept in this
 * browser so a chat opened again puts it back with when it was written (COR-2284 C7, Chat's
 * draft-restored drawer).
 *
 * Each chat's draft is one entry of the workspace's `localStorage` view (`workspace-lifetime.ts`),
 * under `chat-draft:<session id>`, holding `{"version": 1, "text": string, "savedAt": number}`
 * (`savedAt` in milliseconds since the epoch). The text is at most {@link MAX_DRAFT_LENGTH}
 * characters: a longer draft is not kept, rather than kept cut short. An entry is no draft when it
 * is empty, does not parse, is of another version, has no text or text over the bound, or is stale:
 * written more than {@link DRAFT_LIFETIME_MILLISECONDS} ago, or later than now. Sending the draft,
 * emptying the box, or Discard draft writes the entry empty.
 */
import { rowTime, viewerTimeZone } from '../../lib/format/clock.ts';

/** The version of the stored entry this store writes and reads. */
export const DRAFT_FORMAT_VERSION = 1;

/** The longest draft the store keeps, in characters. */
export const MAX_DRAFT_LENGTH = 32_000;

/** How long a draft is put back after it was written: thirty days. */
export const DRAFT_LIFETIME_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;

/** How far ahead of now a draft's time may be, for a clock that moved back a little. */
const CLOCK_SKEW_MILLISECONDS = 60 * 1000;

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

/** The own field `name` of `record`, or `undefined`. */
function field(record: object, name: string): unknown {
  return Object.hasOwn(record, name) ? Reflect.get(record, name) : undefined;
}

/** The draft kept for `sessionId` that is still fresh at `now`, or `undefined` when there is none. */
export function readChatDraft(
  storage: DraftStorage,
  sessionId: string,
  now: number,
): ChatDraft | undefined {
  let raw: string | null;
  try {
    raw = storage.getItem(keyOf(sessionId));
  } catch {
    return undefined;
  }
  if (raw === null || raw === '' || raw.length > MAX_DRAFT_LENGTH * 6 + 100) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  if (field(parsed, 'version') !== DRAFT_FORMAT_VERSION) return undefined;
  const text = field(parsed, 'text');
  const savedAt = field(parsed, 'savedAt');
  if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_DRAFT_LENGTH) {
    return undefined;
  }
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) return undefined;
  if (savedAt > now + CLOCK_SKEW_MILLISECONDS) return undefined;
  if (now - savedAt > DRAFT_LIFETIME_MILLISECONDS) return undefined;
  return { text, savedAt };
}

/**
 * Keeps `text` as the draft of `sessionId`, written at `now`. An empty text forgets the draft, and
 * so does one over {@link MAX_DRAFT_LENGTH}, so an older, shorter draft is never put back over it.
 */
export function writeChatDraft(
  storage: DraftStorage,
  sessionId: string,
  text: string,
  now: number,
): void {
  const value =
    text.trim() === '' || text.length > MAX_DRAFT_LENGTH
      ? ''
      : JSON.stringify({ version: DRAFT_FORMAT_VERSION, text, savedAt: now });
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
