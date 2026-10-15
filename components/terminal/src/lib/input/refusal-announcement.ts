import type { InputRefusal, InputRefusalReason } from './input-types.ts';

/**
 * What the reader is told when input did not reach the shell. Input is never queued or replayed,
 * so a dropped keystroke is otherwise invisible to someone who cannot see that nothing happened.
 */
const MESSAGES: Readonly<Record<Exclude<InputRefusalReason, 'read-only'>, string>> = {
  paused: 'Terminal input paused. Keystrokes are not being sent.',
  'unknown-delivery': 'Terminal input stopped: the last input may not have been delivered.',
  frozen: 'Terminal input stopped. Keystrokes are not being sent.',
  oversized: 'Input was too large and was not sent.',
  closed: 'Terminal input is unavailable. Input was not sent.',
  malformed: 'Input could not be sent.',
  'hook-failed': 'A key press was ignored.',
};

const READ_ONLY_MESSAGE = 'The terminal is read-only. Nothing was sent.';

/** The announcement for `refusal`, or `undefined` for a read-only keystroke, which is expected. */
function messageFor(refusal: InputRefusal): string | undefined {
  if (refusal.reason !== 'read-only') return MESSAGES[refusal.reason];
  // Typing into a read-only view is refused all the time and said once by the state's own copy;
  // a paste or an interrupt was asked for on purpose and deserves an answer.
  return refusal.source === undefined ? undefined : READ_ONLY_MESSAGE;
}

export type RefusalAnnouncer = {
  /** Announce `refusal` unless it is a read-only keystroke or a keystroke repeating the last announcement. */
  refused(refusal: InputRefusal): void;
  /** Forget the last announcement, so the next refusal is announced even if it repeats it. */
  reset(): void;
};

/**
 * Turns refusals into announcements, saying each one once. A held key or a burst of typing into a
 * frozen terminal produces the same refusal for every keystroke; only the first is announced until
 * something else is, or {@link RefusalAnnouncer.reset} says the situation changed.
 */
export function createRefusalAnnouncer(announce: (message: string) => void): RefusalAnnouncer {
  let last: string | undefined;
  return {
    refused(refusal) {
      const message = messageFor(refusal);
      // Typing repeats the same refusal for every key; a paste or an interrupt was asked for once and
      // is answered every time.
      if (message === undefined || (refusal.source === undefined && message === last)) return;
      last = message;
      announce(message);
    },
    reset() {
      last = undefined;
    },
  };
}
