/**
 * COR-2171: the status line of a plugin trigger, state by state: the word, what follows it, which
 * control the state offers, and the code that goes last.
 */
import { describe, expect, test } from 'bun:test';

import type { WorkflowListener } from '../../lib/workflow-files.ts';
import { nextTryClockPeriod, triggerStatus } from './workflow-trigger-presentation.ts';

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const SINCE = new Date(NOW - 3_600_000).toISOString();

const base: WorkflowListener = {
  state: 'listening',
  since: SINCE,
  code: null,
  lastFiredAt: null,
  retryAt: null,
};

function read(listener: Partial<WorkflowListener>, pluginTitle: string | undefined = 'GitHub') {
  return triggerStatus({ ...base, ...listener }, { now: NOW, pluginTitle });
}

describe('triggerStatus', () => {
  test('gives each state its word, and the tones are Cinder’s to give', () => {
    expect(read({ state: 'listening' }).word).toBe('Listening');
    expect(read({ state: 'ready' }).word).toBe('Ready');
    expect(read({ state: 'standby' }).word).toBe('Standby');
    expect(read({ state: 'waiting-for-secret' }).word).toBe('Waiting for a secret');
    expect(read({ state: 'stopped' }).word).toBe('Stopped');
    expect(read({ state: 'failed', code: 'start-failed' }).word).toBe('Failed');
  });

  test('says only what the word does not, and never the word again', () => {
    for (const state of ['listening', 'ready', 'standby', 'stopped'] as const) {
      const { word, text } = read({ state });
      expect(text.includes(word)).toBe(false);
    }
    const failed = read({ state: 'failed', code: 'start-failed', retryAt: null });
    expect(failed.text).toBe(', the trigger could not start.');
    expect(failed.text.includes(failed.word)).toBe(false);
  });

  test('says when a failed trigger is tried again, in the words a hook delivery uses', () => {
    const retryAt = new Date(NOW + 59 * 60_000).toISOString();
    expect(read({ state: 'failed', code: 'start-failed', retryAt }).text).toBe(
      ', the trigger could not start. Next try in 59 minutes.',
    );
    const soon = new Date(NOW + 40_000).toISOString();
    expect(read({ state: 'failed', code: 'start-failed', retryAt: soon }).text).toBe(
      ', the trigger could not start. Next try in 40 seconds.',
    );
    const due = new Date(NOW - 1_000).toISOString();
    expect(read({ state: 'failed', code: 'start-failed', retryAt: due }).text).toBe(
      ', the trigger could not start. Next try in a moment.',
    );
  });

  test('offers Retry now for a failed start, and the code goes last', () => {
    const failed = read({ state: 'failed', code: 'start-failed' });
    expect(failed.canRetry).toBe(true);
    expect(failed.canEdit).toBe(false);
    expect(failed.code).toBe('start-failed');
  });

  test('offers Edit, not Retry now, for a configuration the plugin refused', () => {
    const refused = read({ state: 'failed', code: 'configuration-refused' });
    expect(refused.canRetry).toBe(false);
    expect(refused.canEdit).toBe(true);
    expect(refused.text).toContain('not tried again until they change');
    expect(refused.code).toBe('configuration-refused');
  });

  test('offers neither control, and no code, for a trigger that has not failed', () => {
    for (const state of [
      'listening',
      'ready',
      'standby',
      'waiting-for-secret',
      'stopped',
    ] as const) {
      const status = read({ state });
      expect(status.canRetry).toBe(false);
      expect(status.canEdit).toBe(false);
      expect(status.code).toBeNull();
    }
  });

  test('names the plugin of a trigger waiting for a secret by title, and "The plugin" before it is known', () => {
    expect(read({ state: 'waiting-for-secret' }, 'GitHub').text).toBe('. GitHub needs one: ');
    expect(read({ state: 'waiting-for-secret' }, undefined).text).toBe('. The plugin needs one: ');
    expect(read({ state: 'waiting-for-secret' }).settings).toEqual({
      link: 'add it in Plugins settings',
      after: '.',
    });
    expect(read({ state: 'listening' }).settings).toBeNull();
  });

  test('says when a run last started, as its own sentence', () => {
    expect(read({}).lastStarted).toBeNull();
    expect(read({ lastFiredAt: new Date(NOW).toISOString() }).lastStarted).toMatch(
      /^Last started a run at \d{1,2}:\d{2} [AP]M\.$/,
    );
  });
});

describe('nextTryClockPeriod', () => {
  const failedAt = (milliseconds: number): WorkflowListener => ({
    ...base,
    state: 'failed',
    code: 'start-failed',
    retryAt: new Date(NOW + milliseconds).toISOString(),
  });

  test('reads each second in the last minute and a half, and each half minute before it', () => {
    expect(nextTryClockPeriod(failedAt(30_000), NOW)).toBe(1_000);
    expect(nextTryClockPeriod(failedAt(3_600_000), NOW)).toBe(30_000);
  });

  test('has nothing to count for a try that is due, none scheduled, or a trigger that has not failed', () => {
    expect(nextTryClockPeriod(failedAt(-1_000), NOW)).toBeNull();
    expect(nextTryClockPeriod({ ...base, state: 'failed', code: 'start-failed' }, NOW)).toBeNull();
    expect(nextTryClockPeriod(base, NOW)).toBeNull();
  });
});
