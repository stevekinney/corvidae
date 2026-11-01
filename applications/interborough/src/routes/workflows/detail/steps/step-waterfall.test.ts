import type { WorkflowTimelineEntry } from '@lostgradient/weft';
import { describe, expect, test } from 'bun:test';

import {
  MINIMUM_BAR_WIDTH,
  openStepNumbers,
  stepWaterfall,
  waterfallOrigin,
} from './step-waterfall.ts';

function entry(overrides: Partial<WorkflowTimelineEntry>): WorkflowTimelineEntry {
  return {
    step: 0,
    operationType: 'activity',
    operationLabel: 'work',
    inputSummary: '{}',
    timestamp: 1_000,
    status: 'completed',
    ...overrides,
  };
}

describe('stepWaterfall', () => {
  test('places each bar by its start and duration, as a share of the run', () => {
    const bars = stepWaterfall(
      [
        entry({ step: 0, timestamp: 1_000, duration: 250 }),
        entry({ step: 1, timestamp: 1_250, duration: 750 }),
      ],
      { runStartedAt: 1_000, now: 5_000 },
    );
    expect(bars.get(0)).toMatchObject({ offset: 0, width: 25, open: false, instant: false });
    expect(bars.get(1)).toMatchObject({ offset: 25, width: 75, open: false, startedAfter: 250 });
  });

  test('starts the scale at the run, so a first step that began later does not sit at the left edge', () => {
    const bars = stepWaterfall([entry({ step: 0, timestamp: 1_500, duration: 500 })], {
      runStartedAt: 1_000,
      now: 9_000,
    });
    expect(bars.get(0)).toMatchObject({ offset: 50, width: 50, startedAfter: 500 });
  });

  test('starts the scale at the first step when that is earlier than the run', () => {
    expect(waterfallOrigin([entry({ timestamp: 400 })], 1_000)).toBe(400);
    expect(waterfallOrigin([], undefined)).toBeUndefined();
  });

  test('draws a running step up to now, marks it open, and lets it stretch the scale', () => {
    const bars = stepWaterfall(
      [
        entry({ step: 0, timestamp: 1_000, duration: 100 }),
        entry({ step: 1, timestamp: 1_100, status: 'running' }),
      ],
      { runStartedAt: 1_000, now: 2_000 },
    );
    expect(bars.get(1)).toMatchObject({ open: true, instant: false, offset: 10, width: 90 });
    expect(bars.get(0)?.width).toBe(10);
  });

  test('draws a step that settled with no duration as a hairline at its start', () => {
    const bars = stepWaterfall(
      [entry({ step: 0, timestamp: 1_000, duration: 1_000 }), entry({ step: 1, timestamp: 1_500 })],
      { runStartedAt: 1_000, now: 3_000 },
    );
    expect(bars.get(1)).toMatchObject({ instant: true, open: false, width: MINIMUM_BAR_WIDTH });
  });

  test('keeps a very short step visible and inside the run', () => {
    const bars = stepWaterfall(
      [
        entry({ step: 0, timestamp: 1_000, duration: 1 }),
        entry({ step: 1, timestamp: 100_999, duration: 1 }),
      ],
      { runStartedAt: 1_000, now: 200_000 },
    );
    expect(bars.get(0)?.width).toBe(MINIMUM_BAR_WIDTH);
    const last = bars.get(1);
    expect((last?.offset ?? 0) + (last?.width ?? 0)).toBeLessThanOrEqual(100);
  });

  test('gives a step with no usable start no bar', () => {
    const bars = stepWaterfall(
      [
        entry({ step: 0, timestamp: Number.NaN }),
        entry({ step: 1, timestamp: 1_000, duration: 5 }),
      ],
      { runStartedAt: 1_000, now: 2_000 },
    );
    expect(bars.has(0)).toBe(false);
    expect(bars.has(1)).toBe(true);
  });

  test('puts every step at the origin when the run has no extent', () => {
    const bars = stepWaterfall([entry({ step: 0, timestamp: 1_000 })], {
      runStartedAt: 1_000,
      now: 1_000,
    });
    expect(bars.get(0)).toMatchObject({ offset: 0, width: MINIMUM_BAR_WIDTH, instant: true });
  });

  test('draws nothing for a run with no steps', () => {
    expect(stepWaterfall([], { runStartedAt: 1_000, now: 2_000 }).size).toBe(0);
  });

  test('treats a step whose clock reads before the origin as starting at it', () => {
    const bars = stepWaterfall([entry({ step: 0, timestamp: 900, duration: 100 })], {
      runStartedAt: 1_000,
      now: 2_000,
    });
    expect(bars.get(0)?.startedAfter).toBe(0);
  });

  test('closes a running entry once a later entry exists, ending its bar where the next began', () => {
    // A run that parked on a signal and resumed: step 0 stayed `running`, and the run is still going.
    const bars = stepWaterfall(
      [
        entry({ step: 0, timestamp: 1_000, status: 'running' }),
        entry({ step: 1, timestamp: 1_400, duration: 100 }),
        entry({ step: 2, timestamp: 1_500, duration: 500 }),
      ],
      { runStartedAt: 1_000, runStatus: 'running', now: 61_500 },
    );
    expect(bars.get(0)).toMatchObject({ open: false, instant: false, offset: 0 });
    // 400 of the 1,000 ms the scale spans; it does not run to `now`.
    expect(bars.get(0)?.width).toBeCloseTo(40, 5);
  });

  test('keeps the scale from growing with now when the only running entry is a stale one', () => {
    const entries = [
      entry({ step: 0, timestamp: 1_000, status: 'running' }),
      entry({ step: 1, timestamp: 1_400, duration: 100 }),
    ];
    const early = stepWaterfall(entries, { runStartedAt: 1_000, runStatus: 'running', now: 2_000 });
    const late = stepWaterfall(entries, {
      runStartedAt: 1_000,
      runStatus: 'running',
      now: 9_999_999,
    });
    expect(late.get(0)).toEqual(early.get(0));
    expect(late.get(1)).toEqual(early.get(1));
  });

  test('closes the last running entry of a finished run, as a point in time', () => {
    for (const runStatus of ['completed', 'failed', 'cancelled', 'timed-out']) {
      const bars = stepWaterfall(
        [
          entry({ step: 0, timestamp: 1_000, duration: 500 }),
          entry({ step: 1, timestamp: 1_500, status: 'running' }),
        ],
        { runStartedAt: 1_000, runStatus, now: 99_999_999 },
      );
      expect(bars.get(1)).toMatchObject({ open: false, instant: true, width: MINIMUM_BAR_WIDTH });
    }
  });

  test('draws a running last step of a run that is still going up to now', () => {
    const bars = stepWaterfall([entry({ step: 0, timestamp: 1_000, status: 'running' })], {
      runStartedAt: 1_000,
      runStatus: 'running',
      now: 2_000,
    });
    expect(bars.get(0)).toMatchObject({ open: true });
  });
});

describe('openStepNumbers', () => {
  const running = (step: number) => entry({ step, status: 'running' });

  test('is the last step only, and only while the run is going', () => {
    expect(openStepNumbers([running(0), running(1)], 'running')).toEqual(new Set([1]));
    expect(openStepNumbers([running(0), running(1)], 'suspended')).toEqual(new Set([1]));
    expect(openStepNumbers([running(0), running(1)], undefined)).toEqual(new Set([1]));
  });

  test('is empty for a run that has finished, whatever its entries say', () => {
    for (const status of ['completed', 'failed', 'cancelled', 'timed-out']) {
      expect(openStepNumbers([running(0)], status).size).toBe(0);
    }
  });

  test('does not count a settled last step, or a running one that has a duration', () => {
    expect(openStepNumbers([entry({ step: 0 })], 'running').size).toBe(0);
    expect(
      openStepNumbers([entry({ step: 0, status: 'running', duration: 5 })], 'running').size,
    ).toBe(0);
  });

  test('finds the last step whatever order the entries arrive in', () => {
    expect(openStepNumbers([running(2), entry({ step: 0 }), running(1)], 'running')).toEqual(
      new Set([2]),
    );
  });
});
