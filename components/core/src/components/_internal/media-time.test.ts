import { describe, expect, test } from 'bun:test';

import { formatMediaTime, seekFractionForKey } from './media-time.ts';

describe('formatMediaTime', () => {
  test.each([
    [0, '0:00'],
    [4.9, '0:04'],
    [65, '1:05'],
    [599, '9:59'],
    [3600, '1:00:00'],
    [3725, '1:02:05'],
    [36_000, '10:00:00'],
  ])('formats %p seconds as %p', (seconds, expected) => {
    expect(formatMediaTime(seconds)).toBe(expected);
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -3])(
    'reads %p as 0:00',
    (seconds) => {
      expect(formatMediaTime(seconds)).toBe('0:00');
    },
  );
});

describe('seekFractionForKey', () => {
  test('arrow keys move five seconds', () => {
    expect(seekFractionForKey('ArrowRight', 0.5, 100)).toBeCloseTo(0.55);
    expect(seekFractionForKey('ArrowUp', 0.5, 100)).toBeCloseTo(0.55);
    expect(seekFractionForKey('ArrowLeft', 0.5, 100)).toBeCloseTo(0.45);
    expect(seekFractionForKey('ArrowDown', 0.5, 100)).toBeCloseTo(0.45);
  });

  test('page keys move a tenth of the duration', () => {
    expect(seekFractionForKey('PageUp', 0.5, 100)).toBeCloseTo(0.6);
    expect(seekFractionForKey('PageDown', 0.5, 100)).toBeCloseTo(0.4);
  });

  test('clamps to the start and the end', () => {
    expect(seekFractionForKey('ArrowRight', 0.99, 100)).toBe(1);
    expect(seekFractionForKey('PageDown', 0.05, 100)).toBe(0);
  });

  test('leaves Home, End, and other keys to the browser', () => {
    expect(seekFractionForKey('Home', 0.5, 100)).toBeUndefined();
    expect(seekFractionForKey('End', 0.5, 100)).toBeUndefined();
    expect(seekFractionForKey('toString', 0.5, 100)).toBeUndefined();
  });

  test('leaves every key to the browser without a known duration', () => {
    expect(seekFractionForKey('ArrowRight', 0.5, Number.NaN)).toBeUndefined();
    expect(seekFractionForKey('ArrowRight', 0.5, 0)).toBeUndefined();
  });
});
