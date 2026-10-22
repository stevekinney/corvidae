import { describe, expect, test } from 'bun:test';

import {
  dateTimeForControl,
  displayTimeZone,
  elementId,
  iconLabel,
  matchesPattern,
  plainText,
} from './node-helpers.ts';
import type { A2uiRenderContext } from './render-context.ts';

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

  test('dateTimeForControl shows a zoned value in the time zone it is given', () => {
    const zoned = '2025-12-15T17:00:00Z';
    expect(dateTimeForControl(zoned, 'minute', 'America/New_York')).toBe('2025-12-15T12:00');
    expect(dateTimeForControl(zoned, 'minute', 'Asia/Tokyo')).toBe('2025-12-16T02:00');
    expect(dateTimeForControl(zoned, 'time', 'Asia/Tokyo')).toBe('02:00');
    expect(dateTimeForControl(zoned, 'day', 'UTC')).toBe('2025-12-15');
    // A value without a zone is a wall-clock time, so no zone moves it.
    expect(dateTimeForControl('2025-12-15T17:30', 'minute', 'Asia/Tokyo')).toBe('2025-12-15T17:30');
  });

  test('displayTimeZone shows UTC until the surface mounts, unless the host names a zone', () => {
    expect(displayTimeZone(undefined, false)).toBe('UTC');
    expect(displayTimeZone(undefined, true)).toBeUndefined();
    expect(displayTimeZone('Asia/Tokyo', false)).toBe('Asia/Tokyo');
    expect(displayTimeZone('Asia/Tokyo', true)).toBe('Asia/Tokyo');
  });

  test('plainText keeps intraword underscores, as CommonMark does', () => {
    expect(plainText('save_file_as')).toBe('save_file_as');
    expect(plainText('snake__case__name')).toBe('snake__case__name');
    expect(plainText('an _emphasized_ and __strong__ word')).toBe('an emphasized and strong word');
    expect(plainText('a*b*c and **bold**')).toBe('abc and bold');
  });

  test('matchesPattern reports an invalid pattern as undefined', () => {
    expect(matchesPattern('^a', 'abc')).toBe(true);
    expect(matchesPattern('^b', 'abc')).toBe(false);
    expect(matchesPattern('(', 'abc')).toBeUndefined();
    // A TextField's validationRegexp runs in linear time too.
    expect(matchesPattern('^(a+)+$', `${'a'.repeat(5000)}!`)).toBe(false);
    expect(matchesPattern('^(a)\\1$', 'aa')).toBeUndefined();
  });

  test('iconLabel turns an icon name into words', () => {
    expect(iconLabel('shoppingCart')).toBe('Shopping cart');
    expect(iconLabel('add')).toBe('Add');
  });

  test('elementId never gives two different components the same id', () => {
    const context = { idPrefix: 'a2ui' } as A2uiRenderContext;
    const ids = ['field/a', 'field_a', 'field-a', 'field.a'].map((id) =>
      elementId(context, id, ''),
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(elementId(context, 'row', '/items/0')).not.toBe(elementId(context, 'row', '/items_0'));
    // A part of one component's id never equals another component's id.
    expect(elementId(context, 'field', '', 'description')).not.toBe(
      elementId(context, 'field-description', ''),
    );
    expect(elementId(context, 'pick', '', 'one')).not.toBe(elementId(context, 'pick-one', ''));
  });
});
