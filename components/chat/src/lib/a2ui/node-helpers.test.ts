import { describe, expect, test } from 'bun:test';

import { dateTimeForControl, iconLabel, matchesPattern } from './node-helpers.ts';

describe('node helpers', () => {
  test('dateTimeForControl shapes ISO values for each control', () => {
    expect(dateTimeForControl('2025-12-15', 'day')).toBe('2025-12-15');
    expect(dateTimeForControl('2025-12-15', 'minute')).toBe('2025-12-15T00:00');
    expect(dateTimeForControl('2025-12-15T17:30:00', 'minute')).toBe('2025-12-15T17:30');
    expect(dateTimeForControl('2025-12-15T17:30:00', 'time')).toBe('17:30');
    expect(dateTimeForControl('09:05', 'time')).toBe('09:05');
    // A zoned value is shown in local time (UTC under the test runner).
    expect(dateTimeForControl('2025-12-15T17:00:00Z', 'minute')).toBe('2025-12-15T17:00');
    expect(dateTimeForControl('not a date', 'day')).toBeUndefined();
  });

  test('matchesPattern reports an invalid pattern as undefined', () => {
    expect(matchesPattern('^a', 'abc')).toBe(true);
    expect(matchesPattern('^b', 'abc')).toBe(false);
    expect(matchesPattern('(', 'abc')).toBeUndefined();
  });

  test('iconLabel turns an icon name into words', () => {
    expect(iconLabel('shoppingCart')).toBe('Shopping cart');
    expect(iconLabel('add')).toBe('Add');
  });
});
