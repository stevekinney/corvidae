import { describe, expect, test } from 'bun:test';

import { formatStoredField, isJson, textOf } from './key-value.ts';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('textOf', () => {
  test('is the text of valid UTF-8, the empty text for an empty value, and none for binary', () => {
    expect(textOf(bytes('hello'))).toBe('hello');
    expect(textOf(new Uint8Array())).toBe('');
    expect(textOf(new Uint8Array([0xff, 0xfe, 0x00]))).toBeUndefined();
  });
});

describe('isJson', () => {
  test('is true for any JSON and false for text', () => {
    expect(isJson('{"a":1}')).toBe(true);
    expect(isJson('3')).toBe(true);
    expect(isJson('{')).toBe(false);
  });
});

describe('formatStoredField', () => {
  test('writes an ISO timestamp as a day and time, and leaves every other value to the inspector', () => {
    expect(formatStoredField({ value: '2026-11-01T22:12:00Z' })).toMatch(
      /^(Today|[A-Z][a-z]{2} [A-Z][a-z]{2} \d{1,2}), \d{1,2}:\d{2} (AM|PM)$/,
    );
    expect(formatStoredField({ value: 'refund order 4471' })).toBeUndefined();
    expect(formatStoredField({ value: '2026-11-01' })).toBeUndefined();
    expect(formatStoredField({ value: 14 })).toBeUndefined();
    expect(formatStoredField({ value: '2026-13-45T99:99:99Z' })).toBeUndefined();
  });
});
