import type { TerminalState } from './terminal.types.ts';

/** The recovery actions the state table of `documentation/terminal/experience.md` names. */
export type RecoveryActionId = 'new-session' | 'try-again' | 'retry' | 'check-cleanup' | 'cancel';

export type RecoveryAction = {
  id: RecoveryActionId;
  label: string;
  /** Replacement is blocked until cleanup is complete; the action is shown but cannot be used. */
  disabled: boolean;
};

const LABELS: Readonly<Record<RecoveryActionId, string>> = {
  'new-session': 'New session',
  'try-again': 'Try again',
  retry: 'Retry',
  'check-cleanup': 'Check cleanup',
  cancel: 'Cancel',
};

/**
 * Which actions each state offers, in reading order. `engine-load-failed` is absent on purpose:
 * its `Retry` belongs to the host's recovery request and the frame's reload control, which the
 * component already renders. `backpressured` offers none: the client queues nothing while input is held, so there is nothing for `Cancel` to cancel, and the reader waits for capacity or ends the session some other way; `writable` offers `New session` for the explicit restart, and `read-only` shows it disabled.
 */
const BY_STATE: Readonly<Partial<Record<TerminalState, readonly RecoveryActionId[]>>> = {
  empty: ['new-session'],
  writable: ['new-session'],
  'read-only': ['new-session'],
  loading: ['cancel'],
  connecting: ['cancel'],
  backpressured: [],
  exited: ['new-session'],
  disconnected: ['new-session'],
  denied: ['try-again', 'new-session'],
  failed: ['retry'],
  'cleanup-incomplete': ['check-cleanup'],
};

/** Starting another session replaces this one, so it waits for cleanup. */
const REPLACES_SESSION: ReadonlySet<RecoveryActionId> = new Set(['new-session', 'retry']);

/**
 * The actions to render for `state`: those the state allows and the host handles. While cleanup is
 * pending, the actions that would replace the session are present but disabled; nothing else is
 * offered in `cleanup-incomplete` than checking the cleanup result.
 */
export function recoveryActions(
  state: TerminalState,
  offered: Readonly<Partial<Record<RecoveryActionId, boolean>>>,
  cleanupPending: boolean,
): RecoveryAction[] {
  return (BY_STATE[state] ?? [])
    .filter((id) => offered[id] === true)
    .map((id) => ({
      id,
      label: LABELS[id],
      disabled:
        (cleanupPending && REPLACES_SESSION.has(id)) ||
        // A read-only view cannot be restarted until its attachment is cleaned up.
        (state === 'read-only' && id === 'new-session'),
    }));
}
