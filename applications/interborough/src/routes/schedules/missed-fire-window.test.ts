import { describe, expect, test } from 'bun:test';

import {
  formatMissedFireRange,
  missedFireWindowOf,
  withMissedFireWindow,
} from './missed-fire-window.ts';

const WINDOW = { id: '1000:181000', windowStart: 1_000, windowEnd: 181_000, missedCount: 3 };

describe('missedFireWindowOf', () => {
  test('reads the window and the count a schedule:missed-fire frame carries', () => {
    expect(
      missedFireWindowOf({
        scheduleId: 'nightly',
        windowStart: 1_000,
        windowEnd: 181_000,
        missedCount: 3,
      }),
    ).toEqual(WINDOW);
  });

  test.each([
    ['null', null],
    ['text', 'missed'],
    ['no window', { scheduleId: 'nightly', missedCount: 3 }],
    ['a count that is not a number', { ...WINDOW, missedCount: '3' }],
    ['a bound that is not finite', { ...WINDOW, windowEnd: Number.POSITIVE_INFINITY }],
  ])('reads nothing from %s', (_name, payload) => {
    expect(missedFireWindowOf(payload)).toBeUndefined();
  });

  test('reads only the payload’s own fields, never a prototype’s', () => {
    const inherited = Object.create(WINDOW) as object;
    expect(missedFireWindowOf(inherited)).toBeUndefined();
  });
});

describe('withMissedFireWindow', () => {
  test('lists the newest window first', () => {
    const later = { id: '500000:600000', windowStart: 500_000, windowEnd: 600_000, missedCount: 1 };
    expect(withMissedFireWindow([WINDOW], later)).toEqual([later, WINDOW]);
  });

  test('does not list a window twice, as when a reconnect replays its frame', () => {
    const seen = [WINDOW];
    expect(withMissedFireWindow(seen, { ...WINDOW })).toBe(seen);
  });
});

describe('formatMissedFireRange', () => {
  test('names both bounds', () => {
    const text = formatMissedFireRange(WINDOW);
    expect(text).toContain(' to ');
    expect(text.split(' to ')).toHaveLength(2);
  });
});
