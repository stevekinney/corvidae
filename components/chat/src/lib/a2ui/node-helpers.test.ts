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
  toJsonValue,
} from './node-helpers.ts';
import type { A2uiRenderContext } from './render-context.ts';
import type { A2uiAction } from './types.ts';

function evaluation(overrides: Partial<A2uiEvaluationContext> = {}): A2uiEvaluationContext {
  return { read: () => undefined, scope: '', report: () => {}, ...overrides };
}

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

  test('dateTimeForControl falls back to the runtime zone for a zone it does not know', () => {
    // The runner's zone is UTC.
    expect(dateTimeForControl('2025-12-15T17:00:00Z', 'minute', 'Not/AZone')).toBe(
      '2025-12-15T17:00',
    );
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

  test('failingCheck returns the first failing check’s message', () => {
    const checks = [
      null,
      { condition: true, message: 'fine' },
      { condition: false, message: 'no' },
    ];
    expect(failingCheck(checks, evaluation())).toBe('no');
    expect(failingCheck([{ condition: true, message: 'fine' }], evaluation())).toBeUndefined();
    expect(failingCheck('not a list', evaluation())).toBeUndefined();
  });

  test('runAction runs a function call as a user-activated action', () => {
    const opened: string[] = [];
    const dispatched: A2uiAction[] = [];
    const context = { dispatch: (action: A2uiAction) => dispatched.push(action) } as never;
    const scope = evaluation({ openUrl: (url) => opened.push(url), baseUrl: 'https://a.test/' });
    const component = { id: 'go', component: 'Button' };

    runAction(
      { functionCall: { call: 'openUrl', args: { url: '/next' } } },
      component,
      context,
      scope,
    );
    runAction({ functionCall: { call: 7 } }, component, context, scope);
    runAction({ event: { name: 7 } }, component, context, scope);
    runAction(null, component, context, scope);

    expect(opened).toEqual(['https://a.test/next']);
    expect(dispatched).toEqual([]);
  });

  test('toJsonValue keeps JSON and turns anything else into null', () => {
    expect(toJsonValue({ a: [1, 'b', true, null], n: Number.NaN, f: () => 1 })).toEqual({
      a: [1, 'b', true, null],
      n: null,
      f: null,
    });
    expect(toJsonValue(JSON.parse('{"__proto__": {"x": 1}, "y": 2}'))).toEqual({ y: 2 });
    expect(toJsonValue(undefined)).toBeNull();
  });

  test('evaluationContext reads the model and reports as a function error on the component', () => {
    const reports: unknown[][] = [];
    const context = {
      model: { get: (pointer: string) => (pointer === '/name' ? 'Ada' : undefined) },
      locale: 'en-US',
      report: (...entry: unknown[]) => reports.push(entry),
    } as unknown as A2uiRenderContext;
    const scope = evaluationContext(context, 'field', '/items/0');

    expect(scope.read('/name')).toBe('Ada');
    scope.report('broken');
    expect(reports).toEqual([['function-error', 'field', 'broken']]);
    expect(scope.scope).toBe('/items/0');
  });
});
