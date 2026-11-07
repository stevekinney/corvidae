import { describe, expect, test } from 'bun:test';

import { formatStoredField, isJson, TEXT_VIEW_BYTES, textOf, textViewOf } from './key-value.ts';

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

describe('textViewOf', () => {
  test('is none for JSON small enough to lay out as fields, and for empty and binary values', () => {
    expect(textViewOf(bytes('{"a":1}'))).toBeUndefined();
    expect(textViewOf(bytes('3'))).toBeUndefined();
    expect(textViewOf(new Uint8Array())).toBeUndefined();
    expect(textViewOf(new Uint8Array([0xff, 0xfe, 0x00]))).toBeUndefined();
  });

  test('shows a value that is not JSON whole when it is small', () => {
    expect(textViewOf(bytes('server started'))).toEqual({
      shown: 'server started',
      truncated: false,
      reason: 'not-json',
    });
  });

  test('cuts a large value that is not JSON at 64 KB and says it is not JSON', () => {
    const view = textViewOf(bytes('log line\n'.repeat(20_000)));
    expect(view?.truncated).toBe(true);
    expect(view?.reason).toBe('not-json');
    expect(new TextEncoder().encode(view?.shown ?? '').byteLength).toBeLessThanOrEqual(
      TEXT_VIEW_BYTES,
    );
    expect(view?.shown.startsWith('log line\nlog line')).toBe(true);
  });

  test('shows JSON past 64 KB as text, because it is too large for Fields and JSON', () => {
    const view = textViewOf(bytes(JSON.stringify({ rows: 'x'.repeat(TEXT_VIEW_BYTES) })));
    expect(view?.truncated).toBe(true);
    expect(view?.reason).toBe('too-large');
  });

  test('never ends in half a character, and reads each value with a decoder of its own', () => {
    // Three-byte characters: 65,536 is not a multiple of three, so the cut falls inside one.
    const view = textViewOf(bytes('€'.repeat(30_000)));
    expect(view?.shown).toBe('€'.repeat(Math.floor(TEXT_VIEW_BYTES / 3)));
    expect(textViewOf(bytes('abc'))?.shown).toBe('abc');
  });
});
