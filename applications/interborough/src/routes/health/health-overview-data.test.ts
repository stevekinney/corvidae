/**
 * The counts and metric cards of the Health overview. A run that waits on a review has started and
 * counts under Needs you, so it is not running, done or failed (decisions, Nov 2).
 */
import { describe, expect, test } from 'bun:test';

import {
  finishTime,
  medianFinish,
  parseRunPage,
  runningNow,
  startedCaption,
  startedSummary,
  waitingCaption,
  waitingRuns,
  type RunSummary,
} from './health-overview-data.ts';

const run = (id: string, status: string, startedMs = 0, endedMs = 0): RunSummary => ({
  id,
  status,
  createdAt: startedMs,
  updatedAt: endedMs,
});

describe('waiting runs', () => {
  test('tells what each run waits on, and an approval wins over a question', () => {
    const waiting = waitingRuns([
      { runId: 'a', kind: 'human-wait' },
      { runId: 'b', kind: 'tool-approval' },
      { runId: 'b', kind: 'human-wait' },
      { runId: 'c', kind: 'engine-review' },
    ]);
    expect([...waiting]).toEqual([
      ['a', 'question'],
      ['b', 'approval'],
      ['c', 'review'],
    ]);
  });

  test('a run that waits on a person is not running', () => {
    const waiting = waitingRuns([{ runId: 'b', kind: 'human-wait' }]);
    expect(runningNow([run('a', 'running'), run('b', 'running')], waiting)).toBe(1);
  });
});

describe('Runs started', () => {
  const waiting = waitingRuns([
    { runId: 'wait-1', kind: 'tool-approval' },
    { runId: 'wait-2', kind: 'human-wait' },
  ]);
  const runs = [
    run('done-1', 'completed', 0, 8_000),
    run('done-2', 'completed', 0, 20),
    run('done-3', 'completed', 0, 14),
    // The engine reports a run that paused for an approval as completed.
    run('wait-1', 'completed', 0, 5),
    run('wait-2', 'running'),
  ];

  test('counts every run, and splits the ones that wait from the ones that are done', () => {
    const summary = startedSummary(runs, waiting);
    expect(summary).toMatchObject({ total: 5, done: 3, waiting: 2, other: [] });
    expect(startedCaption(summary)).toBe('3 done · 2 waiting on you');
  });

  test('says what else happened: a run that failed, one still running, one that was canceled', () => {
    const summary = startedSummary(
      [run('a', 'failed'), run('b', 'running'), run('c', 'cancelled'), run('d', 'completed')],
      new Map(),
    );
    expect(startedCaption(summary)).toBe('1 done · 1 failed · 1 running · 1 canceled');
  });

  test('says no run started when none did', () => {
    expect(startedCaption(startedSummary([], new Map()))).toBe('No runs started');
  });

  test('the median is over the runs that finished, not the ones that wait', () => {
    expect(medianFinish(runs, waiting)).toEqual({ milliseconds: 20, count: 3 });
    expect(
      medianFinish([run('a', 'completed', 0, 10), run('b', 'completed', 0, 30)], new Map()),
    ).toEqual({
      milliseconds: 20,
      count: 2,
    });
    expect(medianFinish([run('w', 'running')], new Map())).toBeUndefined();
  });

  test('words a duration', () => {
    expect(finishTime(18)).toBe('<1 s');
    expect(finishTime(8_000)).toBe('8 s');
    expect(finishTime(72_000)).toBe('1m 12s');
    expect(finishTime(3_900_000)).toBe('1h 5m');
  });
});

describe('Needs you', () => {
  test('words the kinds that wait', () => {
    expect(waitingCaption([{ kind: 'tool-approval' }, { kind: 'human-wait' }])).toBe(
      'An approval and a question',
    );
    expect(waitingCaption([{ kind: 'tool-approval' }, { kind: 'tool-approval' }])).toBe(
      '2 approvals',
    );
    expect(waitingCaption([])).toBe('Nothing is waiting on you');
    expect(
      waitingCaption([
        { kind: 'tool-approval' },
        { kind: 'human-wait' },
        { kind: 'engine-review' },
      ]),
    ).toBe('An approval, a question and a workflow review');
  });
});

describe('the run page', () => {
  test('reads the runs and drops what these figures do not use', () => {
    expect(
      parseRunPage({
        items: [{ id: 'a', status: 'running', createdAt: 1, updatedAt: 2, extra: true }],
        total: 1,
      }),
    ).toEqual([{ id: 'a', status: 'running', createdAt: 1, updatedAt: 2 }]);
  });
});
