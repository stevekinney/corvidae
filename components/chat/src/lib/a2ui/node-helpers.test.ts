import { describe, expect, test } from 'bun:test';

import type { A2uiEvaluationContext } from './functions.ts';
import {
  dateTimeForControl,
  elementId,
  evaluationContext,
  failingCheck,
  iconLabel,
  matchesPattern,
  runAction,
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

  test('matchesPattern reports an invalid pattern as undefined', () => {
    expect(matchesPattern('^a', 'abc')).toBe(true);
    expect(matchesPattern('^b', 'abc')).toBe(false);
    expect(matchesPattern('(', 'abc')).toBeUndefined();
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
