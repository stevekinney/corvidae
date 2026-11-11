/**
 * The counts and metric cards of the Health overview. A run that waits on a review has started and
 * counts under Needs you, so it is not running, done or failed (decisions, Nov 2).
 */
import { describe, expect, test } from 'bun:test';

import {
  finishTime,
  medianFinish,
  parseRunPage,
  readEveryRun,
  runningNow,
  startedCaption,
  startedSummary,
  storageUseSize,
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
    expect(startedCaption(summary)).toBe('3 done, 2 waiting on you');
  });

  test('says what else happened: a run that failed, one still running, one that was canceled', () => {
    const summary = startedSummary(
      [run('a', 'failed'), run('b', 'running'), run('c', 'cancelled'), run('d', 'completed')],
      new Map(),
    );
    expect(startedCaption(summary)).toBe('1 done, 1 failed, 1 running, 1 canceled');
  });

  test('when every run finished it says how the day compares with the one before', () => {
    const done = Array.from({ length: 14 }, (_, index) => run(`done-${index}`, 'completed'));
    expect(startedCaption(startedSummary(done, new Map(), 11))).toBe('3 more than the day before');
    expect(startedCaption(startedSummary(done, new Map(), 20))).toBe('6 fewer than the day before');
    expect(startedCaption(startedSummary(done, new Map(), 14))).toBe('The same as the day before');
    // Until the day before is known, or while anything else happened, it says how the runs stand.
    expect(startedCaption(startedSummary(done, new Map()))).toBe('14 done');
    expect(startedCaption(startedSummary([...done, run('late', 'failed')], new Map(), 11))).toBe(
      '14 done, 1 failed',
    );
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
  test('reads the runs and the total, and drops what these figures do not use', () => {
    expect(
      parseRunPage({
        items: [{ id: 'a', status: 'running', createdAt: 1, updatedAt: 2, extra: true }],
        total: 450,
      }),
    ).toEqual({ items: [{ id: 'a', status: 'running', createdAt: 1, updatedAt: 2 }], total: 450 });
  });

  test('reads every page of more than 200 runs, and asks for each only once', async () => {
    const all = Array.from({ length: 450 }, (_, index) => ({
      id: `run-${String(index)}`,
      status: 'completed',
      createdAt: index,
      updatedAt: index + 1,
    }));
    const asked: { limit: number; offset: number }[] = [];
    const runs = await readEveryRun(async (page) => {
      asked.push(page);
      return { items: all.slice(page.offset, page.offset + page.limit), total: all.length };
    });
    expect(runs).toHaveLength(450);
    expect(asked).toEqual([
      { limit: 200, offset: 0 },
      { limit: 200, offset: 200 },
      { limit: 200, offset: 400 },
    ]);
    expect(startedSummary(runs, new Map()).total).toBe(450);
  });

  test('counts a run once when it is read on two pages, and stops at an empty page', async () => {
    const entry = (id: string): RunSummary => run(id, 'running', 1, 2);
    const pages = [
      { items: [entry('a'), entry('b')], total: 5 },
      { items: [entry('b')], total: 5 },
      { items: [], total: 5 },
    ];
    let read = 0;
    const runs = await readEveryRun(async () => pages[read++] ?? { items: [], total: 5 });
    expect(runs.map((found) => found.id)).toEqual(['a', 'b']);
    expect(read).toBe(3);
  });
});

describe('the storage size', () => {
  test('is in gigabytes from about 50 MB up, so a quiet 0.4 GB and the warning’s 1.6 GB read alike', () => {
    expect(storageUseSize(0.4 * 1024 ** 3)).toBe('0.4 GB');
    expect(storageUseSize(1_717_986_918)).toBe('1.6 GB');
    expect(storageUseSize(12 * 1024 ** 3)).toBe('12 GB');
    expect(storageUseSize(30 * 1024 ** 2)).toBe('30 MB');
    expect(storageUseSize(900)).toBe('900 B');
  });
});
