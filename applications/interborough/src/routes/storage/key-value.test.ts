import { describe, expect, test } from 'bun:test';

import { isJson, textOf } from './key-value.ts';

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
