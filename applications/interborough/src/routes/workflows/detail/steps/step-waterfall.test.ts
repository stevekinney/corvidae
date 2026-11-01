import type { WorkflowTimelineEntry } from '@lostgradient/weft';
import { describe, expect, test } from 'bun:test';

import { MINIMUM_BAR_WIDTH, stepWaterfall, waterfallOrigin } from './step-waterfall.ts';

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
});
