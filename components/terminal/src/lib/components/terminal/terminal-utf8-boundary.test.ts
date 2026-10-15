import { describe, expect, test } from 'bun:test';

import { createUtf8Carry, incompleteUtf8Tail } from './terminal-utf8-boundary.ts';

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);

describe('incompleteUtf8Tail', () => {
  test('is zero for text that ends on a character boundary', () => {
    for (const text of ['', 'abc', 'é', '日本', '\u{1f600}', 'a‍', 'x\u{1f468}']) {
      expect(incompleteUtf8Tail(bytes(text))).toBe(0);
    }
  });

  test.each([
    ['one byte of a two-byte character', [0x61, 0xc3], 1],
    ['one byte of a three-byte character', [0x61, 0xe2], 1],
    ['two bytes of a three-byte character (U+200D prefix)', [0x61, 0xe2, 0x80], 2],
    ['one byte of a four-byte character', [0xf0], 1],
    ['two bytes of a four-byte character', [0xf0, 0x9f], 2],
    ['three bytes of a four-byte character', [0xf0, 0x9f, 0x91], 3],
  ])('holds %s', (_name, input, expected) => {
    expect(incompleteUtf8Tail(Uint8Array.from(input))).toBe(expected);
  });

  test.each([
    ['a stray continuation byte', [0x61, 0x80]],
    ['continuation bytes with no lead in range', [0x61, 0x80, 0x80, 0x80]],
    ['an overlong lead', [0x61, 0xc0]],
    ['a lead past U+10FFFF', [0x61, 0xf8]],
    ['an invalid byte', [0x61, 0xff]],
    ['a complete two-byte character', [0xc3, 0xa9]],
    ['a lead followed by enough continuations', [0xe2, 0x80, 0x8d]],
  ])('passes %s through to the engine', (_name, input) => {
    expect(incompleteUtf8Tail(Uint8Array.from(input))).toBe(0);
  });

  test.each([
    ['an overlong three-byte prefix (E0 80)', [0x61, 0xe0, 0x80]],
    ['an overlong three-byte prefix (E0 9F)', [0xe0, 0x9f]],
    ['a surrogate prefix (ED A0)', [0xed, 0xa0]],
    ['an overlong four-byte prefix (F0 8F)', [0xf0, 0x8f]],
    ['an overlong four-byte prefix with two continuations (F0 80 80)', [0xf0, 0x80, 0x80]],
    ['a prefix past U+10FFFF (F4 90)', [0xf4, 0x90]],
    ['a prefix past U+10FFFF with two continuations (F4 90 80)', [0xf4, 0x90, 0x80]],
  ])('passes %s through immediately', (_name, input) => {
    expect(incompleteUtf8Tail(Uint8Array.from(input))).toBe(0);
  });

  test.each([
    ['E0 A0', [0xe0, 0xa0], 2],
    ['E0 BF', [0xe0, 0xbf], 2],
    ['ED 80', [0xed, 0x80], 2],
    ['ED 9F', [0xed, 0x9f], 2],
    ['F0 90', [0xf0, 0x90], 2],
    ['F0 BF', [0xf0, 0xbf], 2],
    ['F4 80', [0xf4, 0x80], 2],
    ['F4 8F', [0xf4, 0x8f], 2],
    ['F4 8F BF', [0xf4, 0x8f, 0xbf], 3],
  ])('still holds the valid prefix %s', (_name, input, expected) => {
    expect(incompleteUtf8Tail(Uint8Array.from(input))).toBe(expected);
  });
});

describe('createUtf8Carry', () => {
  test('passes complete chunks through unchanged', () => {
    const carry = createUtf8Carry();
    expect([...carry.take(bytes('hello'))]).toEqual([...bytes('hello')]);
    expect([...carry.take(bytes('日本'))]).toEqual([...bytes('日本')]);
  });

  test('holds an unfinished sequence and prepends it to the next chunk', () => {
    const whole = bytes('a‍b');
    const carry = createUtf8Carry();
    const first = carry.take(whole.slice(0, 3));
    expect([...first]).toEqual([0x61]);
    const second = carry.take(whole.slice(3));
    expect([...second]).toEqual([0xe2, 0x80, 0x8d, 0x62]);
  });

  test('holds a sequence across several chunks', () => {
    const whole = bytes('\u{1f468}x');
    const carry = createUtf8Carry();
    const written: number[] = [];
    for (const byte of whole) written.push(...carry.take(Uint8Array.of(byte)));
    expect(written).toEqual([...whole]);
  });

  test('an invalid prefix is written at once and never held', () => {
    const carry = createUtf8Carry();
    expect([...carry.take(Uint8Array.of(0x61, 0xe0, 0x80))]).toEqual([0x61, 0xe0, 0x80]);
    expect(carry.pending).toBe(0);
  });

  test('reports what it holds and gives it up on flush', () => {
    const carry = createUtf8Carry();
    carry.take(Uint8Array.of(0x61, 0xe2, 0x80));
    expect(carry.pending).toBe(2);
    expect([...carry.flush()]).toEqual([0xe2, 0x80]);
    expect(carry.pending).toBe(0);
    expect(carry.flush()).toHaveLength(0);
  });

  test('an empty chunk writes nothing and keeps what it held', () => {
    const carry = createUtf8Carry();
    carry.take(Uint8Array.of(0xe2, 0x80));
    expect(carry.take(new Uint8Array(0))).toHaveLength(0);
    expect([...carry.take(Uint8Array.of(0x8d))]).toEqual([0xe2, 0x80, 0x8d]);
  });

  test('returns bytes that do not alias the caller buffer', () => {
    const carry = createUtf8Carry();
    const chunk = bytes('abc');
    const written = carry.take(chunk);
    chunk.fill(0);
    expect([...written]).toEqual([...bytes('abc')]);
  });

  test('every split of a mixed string reassembles to the original bytes', () => {
    const whole = bytes('a‍日\u{1f600}é​z');
    for (let cut = 0; cut <= whole.length; cut += 1) {
      const carry = createUtf8Carry();
      const written = [...carry.take(whole.slice(0, cut)), ...carry.take(whole.slice(cut))];
      expect(written).toEqual([...whole]);
    }
  });
});
