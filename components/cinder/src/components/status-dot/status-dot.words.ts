import type { StatusDotStatus } from './status-dot.types.ts';

/**
 * The status words Interborough lists show, in the order the agreed design's "Status words" table
 * gives them. Each word has exactly one tone, identical in light and dark, so a page never picks
 * its own.
 *
 * - Amber (`warning`) is only for waiting on you and Needs attention: "Waiting on you", "Missed
 *   runs", "Disconnected", "Needs attention" and "Needs sign-in".
 * - Red (`danger`) is only for "Failed", "Gave up", "Can't load", "Not loaded" and "Can't find
 *   workflow" (a schedule whose workflow was deleted, which can't run at all).
 * - Everything else that finished or stopped is neutral, and "Waiting" and "Scheduled" are the
 *   hollow `pending` ring.
 *
 * Some words are scoped: "Ended" is chats only, "Delivered" and "Retrying" are hooks only, and
 * "Connected", "Draining" and "Disconnected" are workers only, and "Live" and "Reconnecting…" are
 * for the line above a streaming run's steps. The table gives them a tone; the
 * page decides where they belong.
 */
export const statusDotWordTones = {
  'Waiting on you': 'warning',
  Running: 'info',
  Waiting: 'pending',
  Scheduled: 'pending',
  Done: 'success',
  'Done · refund not issued': 'neutral',
  'Check not met': 'neutral',
  Approved: 'success',
  Denied: 'neutral',
  'Sent back': 'neutral',
  Expired: 'neutral',
  Failed: 'danger',
  'Gave up': 'danger',
  "Can't load": 'danger',
  "Can't find workflow": 'danger',
  'Not loaded': 'danger',
  Canceled: 'neutral',
  Stopped: 'neutral',
  Paused: 'neutral',
  Off: 'neutral',
  Active: 'success',
  'Missed runs': 'warning',
  Available: 'success',
  Unavailable: 'neutral',
  'Needs setup': 'neutral',
  'Needs attention': 'warning',
  'Needs sign-in': 'warning',
  Ended: 'neutral',
  Delivered: 'success',
  Retrying: 'neutral',
  Connected: 'success',
  Draining: 'neutral',
  Disconnected: 'warning',
  Live: 'info',
  'Reconnecting…': 'pending',
} as const satisfies Record<string, StatusDotStatus>;

/** A status word the word-to-tone table knows, such as `'Waiting on you'` or `'Failed'`. */
export type StatusDotWord = keyof typeof statusDotWordTones;

/**
 * A status word with an optional qualifier after a middle dot, such as
 * `'Running · checking the result'` or `'Missed runs · 4'`. A qualifier does not change the tone,
 * with one exception: a qualifier on `Done` always names what was not achieved
 * (`'Done · refund not issued'`), so a qualified `Done` is neutral and never green, while a plain
 * `'Done'` is green.
 */
export type StatusDotWordLabel = StatusDotWord | `${StatusDotWord} · ${string}`;

const toneByWord: ReadonlyMap<string, StatusDotStatus> = new Map(
  Object.entries(statusDotWordTones),
);

const qualifierSeparator = ' · ';

/**
 * Looks a status word up in the word-to-tone table and returns its status, or `undefined` for a
 * word the table does not know.
 *
 * The phrase is tried whole first; otherwise the part before the first ` · ` is tried, so
 * `'Running · checking the result'` and `'Missed runs · 4'` resolve to their base word. A
 * qualifier on `Done` is the one qualifier that moves the tone: a finished run whose task was not
 * achieved (`'Done · refund not issued'`, or any other `'Done · …'`) is neutral, never green. A typographic apostrophe is read as a straight
 * one, so `'Can’t load'` finds `'Can't load'`.
 */
export function statusForStatusDotWord(word: string): StatusDotStatus | undefined {
  const phrase = word.trim().replaceAll('’', "'");
  const whole = toneByWord.get(phrase);
  if (whole !== undefined) return whole;
  const separatorIndex = phrase.indexOf(qualifierSeparator);
  if (separatorIndex === -1) return undefined;
  const base = phrase.slice(0, separatorIndex).trimEnd();
  if (base === 'Done' && phrase.slice(separatorIndex + qualifierSeparator.length).trim() !== '') {
    return 'neutral';
  }
  return toneByWord.get(base);
}
