import { describe, expect, it } from 'bun:test';

import { A2uiDataModel } from './data-model.svelte.ts';
import {
  A2UI_BASIC_FUNCTIONS,
  type A2uiEvaluationContext,
  callFunction,
  resolveDynamic,
} from './functions.ts';
import type { A2uiJsonValue } from './types.ts';

function context(
  data: A2uiJsonValue = {},
  overrides: Partial<A2uiEvaluationContext> = {},
): A2uiEvaluationContext & { reports: string[]; opened: string[] } {
  const model = new A2uiDataModel(data);
  const reports: string[] = [];
  const opened: string[] = [];
  return {
    read: (pointer) => model.get(pointer),
    scope: '',
    locale: 'en-US',
    report: (message) => reports.push(message),
    openUrl: (url) => opened.push(url),
    baseUrl: 'https://app.example.test/surfaces/1',
    reports,
    opened,
    ...overrides,
  };
}

describe('basic catalog functions', () => {
  it('covers exactly the 14 functions of the v0.9.1 basic catalog', async () => {
    const catalog = (await Bun.file(
      new URL('./basic-catalog.schema.json', import.meta.url),
    ).json()) as {
      functions: Record<string, unknown>;
    };
    expect([...A2UI_BASIC_FUNCTIONS].toSorted() as string[]).toEqual(Object.keys(catalog.functions).toSorted());
  });

  it('formatString interpolates paths, literals, nested calls, and escapes', () => {
    const scope = context({ user: { name: 'Ada' }, items: [{ count: 3 }], price: 1234.5 });
    const value =
      "Hi ${/user/name}, ${'quoted'} \\${not} ${formatNumber(value: ${/price}, decimals: 2)} ${count} ${missing}!";

    expect(callFunction('formatString', { value }, { ...scope, scope: '/items/0' })).toBe(
      'Hi Ada, quoted ${not} 1,234.50 3 !',
    );
  });

  it('required rejects null, undefined, the empty string, and the empty array', () => {
    const scope = context();
    for (const value of [null, undefined, '', []]) {
      expect(callFunction('required', { value }, scope)).toBe(false);
    }
    for (const value of ['x', 0, false, ['a']]) {
      expect(callFunction('required', { value }, scope)).toBe(true);
    }
  });

  it('regex tests the value and reports an invalid pattern', () => {
    const scope = context();
    expect(callFunction('regex', { value: '12345', pattern: '^[0-9]{5}$' }, scope)).toBe(true);
    expect(callFunction('regex', { value: '1234', pattern: '^[0-9]{5}$' }, scope)).toBe(false);
    expect(callFunction('regex', { value: 'x', pattern: '(' }, scope)).toBe(false);
    expect(scope.reports).toHaveLength(1);
  });

  it('length checks the minimum and maximum', () => {
    const scope = context();
    expect(callFunction('length', { value: 'abc', min: 2, max: 3 }, scope)).toBe(true);
    expect(callFunction('length', { value: 'abcd', max: 3 }, scope)).toBe(false);
    expect(callFunction('length', { value: 'a', min: 2 }, scope)).toBe(false);
  });

  it('numeric parses the value and checks its range', () => {
    const scope = context();
    expect(callFunction('numeric', { value: '5', min: 1, max: 10 }, scope)).toBe(true);
    expect(callFunction('numeric', { value: 11, max: 10 }, scope)).toBe(false);
    expect(callFunction('numeric', { value: 'five', min: 1 }, scope)).toBe(false);
  });

  it('email accepts an address and rejects anything else', () => {
    const scope = context();
    expect(callFunction('email', { value: 'jane@example.com' }, scope)).toBe(true);
    expect(callFunction('email', { value: 'jane@' }, scope)).toBe(false);
  });

  it('formatNumber forces decimals and can drop grouping', () => {
    const scope = context();
    expect(callFunction('formatNumber', { value: 1234.5, decimals: 2 }, scope)).toBe('1,234.50');
    expect(callFunction('formatNumber', { value: 1234, grouping: false }, scope)).toBe('1234');
  });

  it('formatCurrency formats with the ISO 4217 code', () => {
    const scope = context();
    expect(callFunction('formatCurrency', { value: 9.5, currency: 'USD' }, scope)).toBe('$9.50');
    expect(
      callFunction('formatCurrency', { value: 1234, currency: 'EUR', decimals: 0 }, scope),
    ).toBe('€1,234');
  });

  it('formatDate interprets a TR35 pattern', () => {
    const scope = context();
    const value = '2026-03-04T15:07:09';
    expect(callFunction('formatDate', { value, format: 'yyyy-MM-dd HH:mm:ss' }, scope)).toBe(
      '2026-03-04 15:07:09',
    );
    expect(callFunction('formatDate', { value, format: "EEEE, MMMM d 'at' h:mm a" }, scope)).toBe(
      'Wednesday, March 4 at 3:07 PM',
    );
    expect(callFunction('formatDate', { value: 'not a date', format: 'yyyy' }, scope)).toBe('');
  });

  it('pluralize picks the locale’s category and falls back to other', () => {
    const scope = context();
    const forms = { one: '1 item', other: 'many items' };
    expect(callFunction('pluralize', { value: 1, ...forms }, scope)).toBe('1 item');
    expect(callFunction('pluralize', { value: 4, ...forms }, scope)).toBe('many items');
    expect(callFunction('pluralize', { value: 0, zero: 'none', other: 'some' }, scope)).toBe(
      'some',
    );
  });

  it('openUrl opens only http and https, resolving relative URLs', () => {
    const scope = context();
    callFunction('openUrl', { url: '/help' }, scope);
    callFunction('openUrl', { url: 'javascript:alert(1)' }, scope);
    callFunction('openUrl', { url: 'data:text/html,hi' }, scope);

    expect(scope.opened).toEqual(['https://app.example.test/help']);
    expect(scope.reports).toHaveLength(2);
  });

  it('openUrl opens a new context with noopener and noreferrer when the host supplies none', () => {
    const calls: unknown[][] = [];
    const original = globalThis.open;
    globalThis.open = (...args: unknown[]) => {
      calls.push(args);
      return null;
    };
    try {
      callFunction(
        'openUrl',
        { url: 'https://example.test/' },
        context({}, { openUrl: undefined }),
      );
    } finally {
      globalThis.open = original;
    }
    expect(calls).toEqual([['https://example.test/', '_blank', 'noopener,noreferrer']]);
  });

  it('and, or, and not combine booleans', () => {
    const scope = context({ yes: true, no: false });
    const yes = { path: '/yes' };
    const no = { path: '/no' };
    expect(callFunction('and', { values: [yes, yes] }, scope)).toBe(true);
    expect(callFunction('and', { values: [yes, no] }, scope)).toBe(false);
    expect(callFunction('or', { values: [no, yes] }, scope)).toBe(true);
    expect(callFunction('or', { values: [no, no] }, scope)).toBe(false);
    expect(callFunction('not', { value: no }, scope)).toBe(true);
    expect(callFunction('not', { value: yes }, scope)).toBe(false);
  });

  it('reports a function outside the basic catalog', () => {
    const scope = context();
    expect(callFunction('eval', { value: '1+1' }, scope)).toBeUndefined();
    expect(scope.reports).toEqual(['the basic catalog has no function "eval"']);
  });
});

describe('resolving dynamic values', () => {
  it('resolves absolute and relative bindings and nested calls', () => {
    const scope = context({ title: 'Inbox', rows: [{ name: 'first' }] });
    expect(resolveDynamic({ path: '/title' }, scope)).toBe('Inbox');
    expect(resolveDynamic({ path: 'name' }, { ...scope, scope: '/rows/0' })).toBe('first');
    expect(resolveDynamic({ call: 'not', args: { value: false } }, scope)).toBe(true);
    expect(resolveDynamic('literal', scope)).toBe('literal');
  });

  it('reads a model change on the next resolution', () => {
    const model = new A2uiDataModel({ count: 1 });
    const scope = { ...context(), read: (pointer: string) => model.get(pointer) };
    model.set('/count', 2);
    expect(resolveDynamic({ path: '/count' }, scope)).toBe(2);
  });
});
