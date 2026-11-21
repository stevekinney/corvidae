import { stepWaterfall } from '@lostgradient/interborough-plugin/step-waterfall';
import { describe, expect, it } from 'bun:test';

import {
  buildTimelineModel,
  describeChange,
  formatMilliseconds,
  readTimeline,
  runIdOf,
  type Timeline,
  type TimelineEntry,
} from './model.ts';

const entry = (overrides: Partial<TimelineEntry> & { step: number }): TimelineEntry => ({
  label: `step-${String(overrides.step)}`,
  operationType: 'activity',
  status: 'completed',
  timestamp: 1_000 + overrides.step * 1_000,
  duration: 500,
  tries: 1,
  ...overrides,
});

const timeline = (entries: TimelineEntry[], truncated = false): Timeline => ({
  runId: 'run-1',
  kind: 'workflow',
  entries,
  truncated,
});

describe('reading what the host answered', () => {
  it('reads a timeline and keeps a step with no duration as one without', () => {
    const read = readTimeline({
      runId: 'run-1',
      kind: 'agent',
      truncated: false,
      entries: [
        {
          step: 1,
          label: 'fetch',
          operationType: 'activity',
          status: 'running',
          timestamp: 5,
          tries: 2,
        },
      ],
    });
    expect(read?.kind).toBe('agent');
    expect(read?.entries[0]).toEqual({
      step: 1,
      label: 'fetch',
      operationType: 'activity',
      status: 'running',
      timestamp: 5,
      tries: 2,
    });
  });

  it('refuses a value that is not a timeline, and one with a step it cannot read', () => {
    expect(readTimeline(undefined)).toBeUndefined();
    expect(readTimeline({ runId: 'r' })).toBeUndefined();
    expect(readTimeline({ runId: 'r', entries: [{ step: 'one' }] })).toBeUndefined();
    expect(readTimeline({ runId: 'r', entries: [null] })).toBeUndefined();
  });

  it('counts a missing or invalid number of tries as one', () => {
    const read = readTimeline({
      runId: 'r',
      entries: [
        {
          step: 1,
          label: 'a',
          operationType: 'activity',
          status: 'completed',
          timestamp: 1,
          tries: 0,
        },
        { step: 2, label: 'b', operationType: 'activity', status: 'completed', timestamp: 2 },
      ],
    });
    expect(read?.entries.map((row) => row.tries)).toEqual([1, 1]);
  });

  it('takes the run from either argument the page is opened with', () => {
    expect(runIdOf({ runId: 'a' })).toBe('a');
    expect(runIdOf({ taskId: 'b' })).toBe('b');
    expect(runIdOf({ runId: '' })).toBeUndefined();
    expect(runIdOf({ runId: 3 })).toBeUndefined();
    expect(runIdOf(undefined)).toBeUndefined();
  });
});

describe('the rows', () => {
  it('lays the bars out with the run page’s own function', () => {
    const entries = [
      entry({ step: 1, timestamp: 1_000, duration: 2_000 }),
      entry({ step: 2, timestamp: 3_000, duration: 1_000, status: 'failed' }),
    ];
    const model = buildTimelineModel(timeline(entries), 10_000);
    const expected = stepWaterfall(entries, { now: 10_000 });
    expect(model.rows.map((row) => row.bar)).toEqual([expected.get(1), expected.get(2)]);
  });

  it('says each step’s status, duration and tries in words', () => {
    const model = buildTimelineModel(
      timeline([
        entry({ step: 1, status: 'completed', duration: 340, tries: 1 }),
        entry({ step: 2, status: 'failed', duration: 1_200, tries: 3 }),
        entry({ step: 3, status: 'timed-out', duration: 61_000, tries: 1 }),
        entry({ step: 4, status: 'cancelled', duration: undefined }),
      ]),
      20_000,
    );
    expect(model.rows.map((row) => [row.statusLabel, row.durationText, row.triesText])).toEqual([
      ['Succeeded', '340 ms', '1 try'],
      ['Failed', '1.2 s', '3 tries'],
      ['Timed out', '1 min 1 s', '1 try'],
      ['Cancelled', 'no duration kept', '1 try'],
    ]);
    expect(model.rows.map((row) => row.statusVariant)).toEqual([
      'success',
      'danger',
      'danger',
      'neutral',
    ]);
  });

  it('calls the last running step running, and an earlier running step ended', () => {
    const model = buildTimelineModel(
      timeline([
        entry({ step: 1, status: 'running', duration: undefined, timestamp: 1_000 }),
        entry({ step: 2, status: 'running', duration: undefined, timestamp: 2_000 }),
      ]),
      9_000,
    );
    expect(model.rows[0]).toMatchObject({ statusLabel: 'Ended', open: false });
    expect(model.rows[1]).toMatchObject({
      statusLabel: 'Running',
      open: true,
      durationText: 'running',
    });
    expect(model.rows[1]?.bar?.open).toBe(true);
    expect(model.summary).toBe('2 steps, 1 running.');
  });

  it('orders the rows by step whatever order the host answered in', () => {
    const model = buildTimelineModel(
      timeline([entry({ step: 3 }), entry({ step: 1 }), entry({ step: 2 })]),
      9_000,
    );
    expect(model.rows.map((row) => row.step)).toEqual([1, 2, 3]);
  });

  it('shows an unknown status as the host sent it, in a neutral badge', () => {
    const model = buildTimelineModel(timeline([entry({ step: 1, status: 'paused' })]), 9_000);
    expect(model.rows[0]).toMatchObject({ statusLabel: 'paused', statusVariant: 'neutral' });
  });

  it('says a step with no usable start has no bar', () => {
    const model = buildTimelineModel(
      timeline([entry({ step: 1, timestamp: Number.NaN, duration: 5 })]),
      9_000,
    );
    expect(model.rows[0]?.bar).toBeUndefined();
    expect(model.rows[0]?.barLabel).toBe('no start time kept');
  });

  it('summarizes a run, an empty run, and a run cut short', () => {
    expect(buildTimelineModel(timeline([]), 1).summary).toBe('No steps yet.');
    const cut = buildTimelineModel(
      timeline([entry({ step: 1, status: 'failed' }), entry({ step: 2 })], true),
      9_000,
    );
    expect(cut.summary).toBe('2 steps, 1 failed or timed out, and more than the page shows.');
    expect(cut.truncated).toBe(true);
  });
});

describe('describing a change', () => {
  const at = (entries: TimelineEntry[]) => buildTimelineModel(timeline(entries), 9_000);

  it('says nothing for the first read and for a read that changed nothing', () => {
    const model = at([entry({ step: 1 })]);
    expect(describeChange(undefined, model)).toBeNull();
    expect(describeChange(model, at([entry({ step: 1 })]))).toBeNull();
  });

  it('names a step that appeared and a step whose status changed', () => {
    const before = at([entry({ step: 1, status: 'running', duration: undefined })]);
    const after = at([entry({ step: 1, status: 'failed' }), entry({ step: 2 })]);
    expect(describeChange(before, after)).toBe(
      'Step 1, step-1, failed. Step 2, step-2, succeeded.',
    );
  });
});

describe('formatting a length of time', () => {
  it.each([
    [0, '0 ms'],
    [999, '999 ms'],
    [1_000, '1 s'],
    [1_240, '1.2 s'],
    [60_000, '1 min'],
    [125_000, '2 min 5 s'],
    [3_600_000, '1 h'],
    [3_780_000, '1 h 3 min'],
    [-5, '0 ms'],
  ])('%d ms reads %s', (milliseconds, expected) => {
    expect(formatMilliseconds(milliseconds)).toBe(expected);
  });
});
