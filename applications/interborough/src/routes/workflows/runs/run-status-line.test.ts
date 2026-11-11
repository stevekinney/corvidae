/**
 * The words of a run page's status line (`run-status-line.ts`): the word and the parts after the
 * time for a run still going, waiting on a person, waiting for a signal, and a goal's attempt
 * checking its result (rows 54l, 54s, 55n, 56g and 56i).
 */
import { describe, expect, test } from 'bun:test';

import { taskFixture } from '../../../lib/bureau-fixtures.test-support.ts';
import { runStatusLine } from './run-status-line.ts';

const STARTED = Date.parse('2026-11-02T10:45:00-06:00');

describe('runStatusLine', () => {
  test('a run still going says how long it has run so far (54l, 06b)', () => {
    const line = runStatusLine({
      status: 'Running',
      startedAt: STARTED,
      over: false,
      now: STARTED + 12_000,
      task: taskFixture({ status: 'working' }),
    });

    expect(line).toEqual({ word: 'Running', phrases: ['12 s so far'], signals: [] });
  });

  test('a run that has ended says nothing more than its word', () => {
    const line = runStatusLine({
      status: 'Done',
      startedAt: STARTED,
      over: true,
      now: STARTED + 60_000,
      task: taskFixture({ status: 'completed' }),
    });

    expect(line).toEqual({ word: 'Done', phrases: [], signals: [] });
  });

  test('a run waiting on a question says how long, and that it needs an answer (54s)', () => {
    const updatedAt = '2026-11-02T09:46:00-06:00';
    const line = runStatusLine({
      status: 'Waiting on you',
      startedAt: Date.parse(updatedAt),
      over: false,
      now: Date.parse(updatedAt) + 3_600_000,
      task: taskFixture({
        status: 'input-required',
        updatedAt,
        openWaits: [{ kind: 'human-wait', reviewId: 'review-1', signalName: 'environment' }],
      }),
    });

    expect(line).toEqual({
      word: 'Waiting on you',
      phrases: ['waiting 1 h', 'needs an answer to continue'],
      signals: [],
    });
  });

  test('a run waiting on an approval says that it needs the person’s approval (55n)', () => {
    const updatedAt = '2026-11-02T10:42:00-06:00';
    const line = runStatusLine({
      status: 'Waiting on you',
      startedAt: Date.parse(updatedAt),
      over: false,
      now: Date.parse(updatedAt) + 240_000,
      task: taskFixture({
        status: 'input-required',
        updatedAt,
        openWaits: [{ kind: 'tool-approval', reviewId: 'review-1', callId: 'call-1' }],
      }),
    });

    expect(line.phrases).toEqual(['waiting 4 min', 'needs your approval to continue']);
  });

  test('a question wins over an approval when a run waits on both', () => {
    const updatedAt = '2026-11-02T10:42:00-06:00';
    const line = runStatusLine({
      status: 'Waiting on you',
      startedAt: Date.parse(updatedAt),
      over: false,
      now: Date.parse(updatedAt) + 30_000,
      task: taskFixture({
        status: 'input-required',
        updatedAt,
        openWaits: [
          { kind: 'tool-approval', reviewId: 'review-1', callId: 'call-1' },
          { kind: 'human-wait', reviewId: 'review-2', signalName: 'environment' },
        ],
      }),
    });

    expect(line.phrases).toEqual(['waiting 30 s', 'needs an answer to continue']);
  });

  test('a workflow run parked on a signal reads Waiting and names the signal (56g)', () => {
    const line = runStatusLine({
      status: 'Running',
      startedAt: STARTED,
      over: false,
      now: STARTED + 5_000,
      waitingForSignals: ['notes-approved'],
    });

    expect(line).toEqual({ word: 'Waiting', phrases: [], signals: ['notes-approved'] });
  });

  test('a task is never Waiting: its wait is a person’s, and a working task reads Running', () => {
    const line = runStatusLine({
      status: 'Running',
      startedAt: STARTED,
      over: false,
      now: STARTED + 5_000,
      task: taskFixture({ status: 'working' }),
      waitingForSignals: ['chat-input'],
    });

    expect(line.word).toBe('Running');
    expect(line.signals).toEqual([]);
  });

  test('a run that ended while its engine still lists a signal does not read Waiting', () => {
    const line = runStatusLine({
      status: 'Running',
      startedAt: STARTED,
      over: true,
      now: STARTED + 5_000,
      waitingForSignals: ['notes-approved'],
    });

    expect(line.word).toBe('Running');
  });

  test('an attempt checking its result reads Running with that qualifier, and says which attempt and how long the agent took (56i)', () => {
    const line = runStatusLine({
      status: 'Done',
      startedAt: STARTED,
      over: false,
      now: STARTED + 300_000,
      task: taskFixture({
        status: 'completed',
        createdAt: '2026-11-02T10:44:00-06:00',
        updatedAt: '2026-11-02T10:45:12-06:00',
      }),
      attempt: { number: 2, of: 5, checking: true },
    });

    expect(line).toEqual({
      word: 'Running, checking the result',
      phrases: ['attempt 2 of 5', 'Agent took 1 min 12 s'],
      signals: [],
    });
  });

  test('an attempt that is not checking is read as any other run', () => {
    const line = runStatusLine({
      status: 'Running',
      startedAt: STARTED,
      over: false,
      now: STARTED + 8_000,
      attempt: { number: 1, of: 3, checking: false },
    });

    expect(line).toEqual({ word: 'Running', phrases: ['8 s so far'], signals: [] });
  });
});
