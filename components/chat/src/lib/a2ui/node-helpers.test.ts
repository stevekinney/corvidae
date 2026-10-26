import { describe, expect, test } from 'bun:test';

import type { A2uiEvaluationContext } from './functions.ts';
import {
  dateTimeForControl,
  displayTimeZone,
  elementId,
  evaluationContext,
  failingCheck,
  iconLabel,
  matchesPattern,
  plainText,
  runAction,
  timeOutOfRange,
  toJsonValue,
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

  test('dateTimeForControl falls back to UTC, not the runtime zone, for a zone it does not know', () => {
    const original = process.env.TZ;
    process.env.TZ = 'Asia/Tokyo';
    try {
      // A runtime-zone fallback would show 02:00 on the 16th here.
      expect(dateTimeForControl('2025-12-15T17:00:00Z', 'minute', 'Not/AZone')).toBe(
        '2025-12-15T17:00',
      );
      expect(dateTimeForControl('2025-12-15T17:00:00Z', 'time', 'Not/AZone')).toBe('17:00');
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  test('dateTimeForControl shows a zoned time-only value in the time zone it is given', () => {
    expect(dateTimeForControl('09:00:00Z', 'time', 'Asia/Kolkata')).toBe('14:30');
    expect(dateTimeForControl('09:00:00+02:00', 'time', 'UTC')).toBe('07:00');
    expect(dateTimeForControl('09:00Z', 'time', 'UTC')).toBe('09:00');
    expect(dateTimeForControl('09:00:00.5-0530', 'time', 'UTC')).toBe('14:30');
    expect(dateTimeForControl('09:00:00Z', 'day', 'UTC')).toBeUndefined();
  });

  test('timeOutOfRange honors zoned time-only bounds', () => {
    expect(timeOutOfRange('08:00', '09:00:00Z', '17:00:00Z', 'UTC')).toBe(true);
    expect(timeOutOfRange('09:00', '09:00:00Z', '17:00:00Z', 'UTC')).toBe(false);
    expect(timeOutOfRange('17:30', '09:00:00Z', '17:00:00Z', 'UTC')).toBe(true);
    // 09:00Z is 14:30 in Kolkata.
    expect(timeOutOfRange('10:00', '09:00:00Z', '17:00:00Z', 'Asia/Kolkata')).toBe(true);
    expect(timeOutOfRange('15:00', '09:00:00Z', '17:00:00Z', 'Asia/Kolkata')).toBe(false);
    expect(timeOutOfRange('08:00', '09:00', '17:00', 'UTC')).toBe(true);
  });

  test('timeOutOfRange treats a range that wraps past midnight as spanning it', () => {
    // 09:00Z to 17:00Z is 18:00 to 02:00 in Tokyo.
    expect(timeOutOfRange('19:00', '09:00:00Z', '17:00:00Z', 'Asia/Tokyo')).toBe(false);
    expect(timeOutOfRange('01:00', '09:00:00Z', '17:00:00Z', 'Asia/Tokyo')).toBe(false);
    expect(timeOutOfRange('18:00', '09:00:00Z', '17:00:00Z', 'Asia/Tokyo')).toBe(false);
    expect(timeOutOfRange('02:00', '09:00:00Z', '17:00:00Z', 'Asia/Tokyo')).toBe(false);
    expect(timeOutOfRange('12:00', '09:00:00Z', '17:00:00Z', 'Asia/Tokyo')).toBe(true);
    expect(timeOutOfRange('17:59', '09:00:00Z', '17:00:00Z', 'Asia/Tokyo')).toBe(true);
    expect(timeOutOfRange('02:01', '09:00:00Z', '17:00:00Z', 'Asia/Tokyo')).toBe(true);
    // A local overnight range wraps the same way.
    expect(timeOutOfRange('23:30', '22:00', '06:00')).toBe(false);
    expect(timeOutOfRange('12:00', '22:00', '06:00')).toBe(true);
    // One bound alone never wraps.
    expect(timeOutOfRange('23:00', '22:00', '')).toBe(false);
    expect(timeOutOfRange('21:00', '22:00', '')).toBe(true);
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

  test('failingCheck returns the first failing check’s message and skips malformed checks', () => {
    const evaluation: A2uiEvaluationContext = {
      read: () => undefined,
      scope: '',
      report: () => {},
    };
    expect(failingCheck('not a list', evaluation)).toBeUndefined();
    expect(
      failingCheck(
        [null, { condition: true, message: 'fine' }, { condition: false, message: 'Not yet' }],
        evaluation,
      ),
    ).toBe('Not yet');
    expect(failingCheck([{ condition: true, message: 'fine' }], evaluation)).toBeUndefined();
  });

  test('runAction runs a function call as a user-activated evaluation', () => {
    const opened: string[] = [];
    const reports: string[] = [];
    const evaluation: A2uiEvaluationContext = {
      read: () => undefined,
      scope: '',
      report: (message) => reports.push(message),
      openUrl: (url) => opened.push(url),
      baseUrl: 'https://app.example.test/',
    };
    const context = { surfaceId: 's', dispatch: () => {} } as unknown as A2uiRenderContext;
    const component = { id: 'go', component: 'Button' };

    runAction(
      { functionCall: { call: 'openUrl', args: { url: '/help' } } },
      component,
      context,
      evaluation,
    );
    runAction({ functionCall: { call: 42 } }, component, context, evaluation);
    runAction(null, component, context, evaluation);

    expect(opened).toEqual(['https://app.example.test/help']);
    expect(reports).toEqual([]);
  });

  test('toJsonValue keeps JSON and turns everything else into null', () => {
    expect(toJsonValue(Number.NaN)).toBeNull();
    expect(toJsonValue(3)).toBe(3);
    expect(toJsonValue([1, undefined, 'a'])).toEqual([1, null, 'a']);
    expect(toJsonValue(JSON.parse('{"a":1,"__proto__":{"x":1},"b":{"c":true}}'))).toEqual({
      a: 1,
      b: { c: true },
    });
    expect(toJsonValue(() => {})).toBeNull();
  });

  test('evaluationContext reads the model and reports function errors for its component', () => {
    const reports: unknown[][] = [];
    const context = {
      model: { get: (pointer: string) => (pointer === '/name' ? 'Ada' : undefined) },
      locale: 'en-US',
      report: (...args: unknown[]) => reports.push(args),
    } as unknown as A2uiRenderContext;
    const evaluation = evaluationContext(context, 'field', '');

    expect(evaluation.read('/name')).toBe('Ada');
    evaluation.report('bad call');
    expect(reports).toEqual([['function-error', 'field', 'bad call']]);
  });
});
