import { describe, expect, test } from 'bun:test';

import { encodeBinaryReport, encodeTextReport } from './input-bytes.ts';

describe('text reports', () => {
  test('encode as UTF-8', () => {
    expect([...encodeTextReport('a')!]).toEqual([0x61]);
    expect([...encodeTextReport('\u0080')!]).toEqual([0xc2, 0x80]);
    expect([...encodeTextReport('é')!]).toEqual([0xc3, 0xa9]);
    expect([...encodeTextReport('あ')!]).toEqual([0xe3, 0x81, 0x82]);
    expect([...encodeTextReport('😀')!]).toEqual([0xf0, 0x9f, 0x98, 0x80]);
  });

  test('keep control bytes and an empty report exactly', () => {
    expect([...encodeTextReport('\u001b[A\r\u0003')!]).toEqual([0x1b, 0x5b, 0x41, 0x0d, 0x03]);
    expect(encodeTextReport('')!.length).toBe(0);
  });

  test('refuse a lone surrogate instead of rewriting it to U+FFFD', () => {
    expect(encodeTextReport('\ud800')).toBeUndefined();
    expect(encodeTextReport('a\udc00b')).toBeUndefined();
  });
});

describe('binary reports', () => {
  test('encode each code unit as one byte, never as UTF-8', () => {
    expect([...encodeBinaryReport('\u0080ÿ')!]).toEqual([0x80, 0xff]);
    expect([...encodeBinaryReport('\u001b[M !!')!]).toEqual([0x1b, 0x5b, 0x4d, 0x20, 0x21, 0x21]);
  });

  test('differ from the text conversion for the same characters', () => {
    expect([...encodeTextReport('\u0080')!]).not.toEqual([...encodeBinaryReport('\u0080')!]);
  });

  test('refuse a unit above 255', () => {
    expect(encodeBinaryReport('Ā')).toBeUndefined();
    expect(encodeBinaryReport('a😀')).toBeUndefined();
  });

  test('encode an empty report as no bytes', () => {
    expect(encodeBinaryReport('')!.length).toBe(0);
  });
});
