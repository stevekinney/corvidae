import { describe, expect, test } from 'bun:test';

import { recoveryActions, type RecoveryActionId } from './terminal-recovery.ts';
import type { TerminalState } from './terminal.types.ts';

const ALL: Record<RecoveryActionId, boolean> = {
  'new-session': true,
  'try-again': true,
  retry: true,
  'check-cleanup': true,
  cancel: true,
};

function labels(state: TerminalState, cleanupPending = false): string[] {
  return recoveryActions(state, ALL, cleanupPending).map((action) => action.label);
}

describe('recoveryActions follows the state table of the experience specification', () => {
  test('each state offers exactly the actions its row names', () => {
    expect(labels('empty')).toEqual(['New session']);
    expect(labels('loading')).toEqual(['Cancel']);
    expect(labels('connecting')).toEqual(['Cancel']);
    expect(labels('writable')).toEqual(['New session']);
    expect(labels('read-only')).toEqual(['New session']);
    // No unsent operation exists to cancel: the client refuses input locally and queues none.
    expect(labels('backpressured')).toEqual([]);
    expect(labels('exited')).toEqual(['New session']);
    expect(labels('disconnected')).toEqual(['New session']);
    expect(labels('denied')).toEqual(['Try again', 'New session']);
    expect(labels('failed')).toEqual(['Retry']);
    expect(labels('cleanup-incomplete')).toEqual(['Check cleanup']);
  });

  test('engine-load-failed keeps its own Retry, which the host recovery request drives', () => {
    expect(labels('engine-load-failed')).toEqual([]);
  });

  test('a read-only view shows New session disabled whether or not cleanup is pending', () => {
    for (const pending of [false, true]) {
      const [action] = recoveryActions('read-only', ALL, pending);
      expect(action).toEqual({ id: 'new-session', label: 'New session', disabled: true });
    }
    expect(recoveryActions('writable', ALL, false)[0]?.disabled).toBe(false);
  });

  test('an action is offered only when the host handles it', () => {
    expect(recoveryActions('denied', { 'try-again': true }, false).map((a) => a.id)).toEqual([
      'try-again',
    ]);
    expect(recoveryActions('exited', {}, false)).toEqual([]);
    expect(
      recoveryActions('cleanup-incomplete', { 'new-session': true, retry: true }, false),
    ).toEqual([]);
  });

  test('replacement is blocked until cleanup is complete, and nothing else is', () => {
    const blocked = (state: TerminalState) =>
      Object.fromEntries(
        recoveryActions(state, ALL, true).map((action) => [action.id, action.disabled]),
      );
    expect(blocked('exited')).toEqual({ 'new-session': true });
    expect(blocked('disconnected')).toEqual({ 'new-session': true });
    expect(blocked('empty')).toEqual({ 'new-session': true });
    expect(blocked('failed')).toEqual({ retry: true });
    expect(blocked('denied')).toEqual({ 'try-again': false, 'new-session': true });
    expect(blocked('cleanup-incomplete')).toEqual({ 'check-cleanup': false });
    expect(blocked('connecting')).toEqual({ cancel: false });
    expect(blocked('backpressured')).toEqual({});
    expect(blocked('writable')).toEqual({ 'new-session': true });
    expect(recoveryActions('exited', ALL, false)[0]?.disabled).toBe(false);
  });
});
