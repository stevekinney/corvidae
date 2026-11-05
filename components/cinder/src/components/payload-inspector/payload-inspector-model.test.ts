import { describe, expect, test } from 'bun:test';

import {
  chooseFieldsLayout,
  classifyArray,
  countWords,
  describeContents,
  describeLongKey,
  describeScalar,
  formatIsoDate,
  headerCount,
  isLongText,
  isNumberColumn,
  isTokenColumn,
  readPartialObject,
} from './payload-inspector-model.ts';
import { SecretValue } from './payload-inspector-secrets.ts';

function pairs(record: Record<string, unknown>, linked = false) {
  return Object.entries(record).map(([key, value]) => ({ key, value, linked }));
}

describe('headerCount', () => {
  test('counts the top-level keys in words', () => {
    expect(headerCount({ a: 1 })).toBe('1 field');
    expect(headerCount({ a: 1, b: 2, c: 3 })).toBe('3 fields');
  });

  test('counts a non-object as one value and an array by its items', () => {
    expect(headerCount('order-4471')).toBe('1 value');
    expect(headerCount([1, 2])).toBe('2 items');
  });

  test('adds the size only above 1 KB', () => {
    expect(headerCount({ a: 1, b: 2 }, { bytes: 1024 })).toBe('2 fields');
    expect(headerCount({ a: 1, b: 2 }, { bytes: 1434 })).toBe('2 fields · 1.4 KB');
    expect(headerCount({ items: [] }, { bytes: 184 * 1024 })).toBe('1 field · 184 KB');
  });

  test('says "so far" while the payload arrives', () => {
    expect(headerCount({ a: 1, b: 2 }, { streaming: true })).toBe('2 fields so far');
  });

  test('describes nested values and groups thousands', () => {
    expect(describeContents({ a: 1, b: 2 })).toBe('2 fields');
    expect(describeContents(Array.from({ length: 2140 }, () => 0))).toBe('2,140 items');
    expect(countWords(1, 'item')).toBe('1 item');
  });
});

describe('chooseFieldsLayout', () => {
  test('a few short pairs read inline', () => {
    expect(chooseFieldsLayout(pairs({ orderId: 4471, amount: '$42.00' }))).toBe('inline');
    expect(
      chooseFieldsLayout(pairs({ orderId: 4471, amount: '$42.00', reason: 'Arrived damaged' })),
    ).toBe('inline');
  });

  test('many short pairs read as a grid', () => {
    const many = Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`k${index}`, 'v']));
    expect(chooseFieldsLayout(pairs(many))).toBe('grid');
  });

  test('five pairs, links, masked values, long text and streaming stay rows', () => {
    const five = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`k${index}`, 'v']));
    expect(chooseFieldsLayout(pairs(five))).toBe('rows');
    expect(chooseFieldsLayout(pairs({ run: 'Run 8f2c' }, true))).toBe('rows');
    expect(chooseFieldsLayout(pairs({ key: new SecretValue() }))).toBe('rows');
    expect(chooseFieldsLayout(pairs({ note: 'x'.repeat(130) }))).toBe('rows');
    expect(chooseFieldsLayout(pairs({ a: 1 }), { streaming: true })).toBe('rows');
    expect(chooseFieldsLayout(pairs({ ['k'.repeat(30)]: 1 }))).toBe('rows');
    expect(chooseFieldsLayout(pairs({ nested: { a: 1 } }))).toBe('rows');
  });
});

describe('classifyArray', () => {
  test('sorts an array into its shape', () => {
    expect(classifyArray([])).toBe('empty');
    expect(classifyArray(['a', 2, null])).toBe('scalars');
    expect(
      classifyArray([
        { a: 1, b: 2 },
        { b: 3, a: 4 },
      ]),
    ).toBe('uniform');
    expect(classifyArray([{ a: 1 }, { b: 2 }])).toBe('mixed');
    expect(classifyArray([{ a: 1 }, 'x'])).toBe('mixed');
    expect(classifyArray([{ a: { nested: true } }])).toBe('mixed');
    expect(classifyArray([{}])).toBe('mixed');
    expect(classifyArray([[1], [2]])).toBe('mixed');
  });
});

describe('describeScalar', () => {
  test('formats only what the JSON says unambiguously', () => {
    expect(describeScalar(null)).toEqual({ kind: 'none' });
    expect(describeScalar('')).toEqual({ kind: 'empty' });
    expect(describeScalar(true)).toEqual({ kind: 'text', text: 'Yes' });
    expect(describeScalar(false)).toEqual({ kind: 'text', text: 'No' });
    expect(describeScalar(900)).toEqual({ kind: 'number', text: '900' });
    expect(describeScalar('delivered')).toEqual({ kind: 'text', text: 'delivered' });
    expect(describeScalar('2026-10-24')).toEqual({ kind: 'text', text: 'Oct 24, 2026' });
    expect(describeScalar(new SecretValue())).toEqual({ kind: 'secret' });
  });

  test('a caller override wins over the default', () => {
    expect(describeScalar(4200, '$42.00')).toEqual({ kind: 'text', text: '$42.00' });
  });
});

describe('formatIsoDate', () => {
  test('writes a date and a dated time, and leaves anything else alone', () => {
    expect(formatIsoDate('2026-10-24')).toBe('Oct 24, 2026');
    expect(formatIsoDate('2026-10-24T10:00:00Z')).toBe('Oct 24, 2026, 10:00 AM');
    expect(formatIsoDate('2026-02-31')).toBeUndefined();
    expect(formatIsoDate('2026-10-24T10:00:00')).toBeUndefined();
    expect(formatIsoDate('Oct 24')).toBeUndefined();
    expect(formatIsoDate('release-2026-10-24')).toBeUndefined();
  });
});

describe('table columns, long text and long keys', () => {
  test('a column of single tokens reads as code and a column of numbers aligns to the end', () => {
    expect(isTokenColumn(['text', 'reasoning', 'SKU-1000'])).toBe(true);
    expect(isTokenColumn(['Your refund is on its way.'])).toBe(false);
    expect(isTokenColumn([1, 2])).toBe(false);
    expect(isNumberColumn([1, 2, 935])).toBe(true);
    expect(isNumberColumn([1, '2'])).toBe(false);
  });

  test('long text is over 120 characters or spans lines', () => {
    expect(isLongText('x'.repeat(121))).toBe(true);
    expect(isLongText('one\ntwo')).toBe(true);
    expect(isLongText('short')).toBe(false);
    expect(isLongText(12)).toBe(false);
  });

  test('a long key reads with its length, and an enormous key is cut', () => {
    expect(describeLongKey('a'.repeat(30))).toBe(`${'a'.repeat(30)} (30 characters)`);
    const enormous = describeLongKey('a'.repeat(2000));
    expect(enormous.endsWith('… (2,000 characters)')).toBe(true);
    expect(enormous.length).toBeLessThan(300);
  });
});

describe('readPartialObject', () => {
  test('is undefined when the text is not an object', () => {
    expect(readPartialObject('[1,2')).toBeUndefined();
    expect(readPartialObject('hello')).toBeUndefined();
  });

  test('lists the fields whose value is whole and names the one still arriving', () => {
    expect(readPartialObject('{"orderId": 4471, "amount": "$42.00", "reason": "Arriv')).toEqual({
      entries: [
        ['orderId', 4471],
        ['amount', '$42.00'],
      ],
      pendingKey: 'reason',
      pendingText: '"Arriv',
    });
  });

  test('a number or keyword is whole only once a delimiter follows it', () => {
    expect(readPartialObject('{"a": 44')).toEqual({
      entries: [],
      pendingKey: 'a',
      pendingText: '44',
    });
    expect(readPartialObject('{"a": true,')).toEqual({ entries: [['a', true]] });
    expect(readPartialObject('{"a": {"b": [1, 2]}, "c"')).toEqual({
      entries: [['a', { b: [1, 2] }]],
      pendingKey: 'c',
      pendingText: '',
    });
  });

  test('a key still arriving, a key waiting for its value and braces inside strings', () => {
    expect(readPartialObject('{"orderId": 1, "rea')).toEqual({ entries: [['orderId', 1]] });
    expect(readPartialObject('{"orderId": 1, "reason"')).toEqual({
      entries: [['orderId', 1]],
      pendingKey: 'reason',
      pendingText: '',
    });
    expect(readPartialObject('{"note": "a } b", "c": 2}')).toEqual({
      entries: [
        ['note', 'a } b'],
        ['c', 2],
      ],
    });
    expect(readPartialObject('{"a": {"b": "}')).toEqual({
      entries: [],
      pendingKey: 'a',
      pendingText: '{"b": "}',
    });
  });

  test('stops at text that is not a key', () => {
    expect(readPartialObject('{ nope')).toEqual({ entries: [] });
  });
});
