import { describe, expect, it } from 'bun:test';

import {
  elapsedMilliseconds,
  isDeadlineElapsed,
  remainingMilliseconds,
} from './goal-workflow-transitions';

const NOW = Date.parse('2026-10-02T01:00:00.000Z');
const bounded = (createdAt: string) =>
  ({ createdAt, bounds: { maximumTotalDurationMs: 60_000 } }) as never;
const unbounded = (createdAt: string) =>
  ({ createdAt, bounds: { maximumTotalTokens: 10 } }) as never;

describe('the aggregate duration of a goal', () => {
  it('is measured from the record creation time', () => {
    const view = bounded('2026-10-02T00:59:30.000Z');
    expect(elapsedMilliseconds(view, NOW)).toBe(30_000);
    expect(remainingMilliseconds(view, NOW)).toBe(30_000);
    expect(isDeadlineElapsed(view, NOW)).toBe(false);
    expect(isDeadlineElapsed(bounded('2026-10-02T00:58:00.000Z'), NOW)).toBe(true);
  });

  it.each(['corrupt', '', 'not-a-date', 'Invalid Date'])(
    'spends a duration bound, rather than never consuming it, when the creation time is %p',
    (createdAt) => {
      const view = bounded(createdAt);
      expect(Number.isFinite(elapsedMilliseconds(view, NOW))).toBe(true);
      expect(elapsedMilliseconds(view, NOW)).toBeGreaterThanOrEqual(60_000);
      expect(remainingMilliseconds(view, NOW)).toBe(0);
      expect(isDeadlineElapsed(view, NOW)).toBe(true);
    },
  );

  it('has no deadline to spend when the goal has no duration bound, whatever the creation time', () => {
    for (const createdAt of ['corrupt', '2026-10-02T00:00:00.000Z']) {
      expect(remainingMilliseconds(unbounded(createdAt), NOW)).toBeUndefined();
      expect(isDeadlineElapsed(unbounded(createdAt), NOW)).toBe(false);
    }
  });
});
