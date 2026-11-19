import { describe, expect, test } from 'bun:test';

import { encodeUtf8, utf8ByteLength } from './utf8.ts';

const samples: [description: string, sample: string][] = [
  ['an empty string', ''],
  ['plain ASCII text', 'plain ASCII'],
  ['control and boundary scalar values', '\u0000\u007f\u0080߿ࠀ￿'],
  ['accented Latin and Greek text', 'café αβγ'],
  ['Japanese and Korean text', '日本語 한글'],
  ['an emoji ZWJ sequence', '\u{1f600}\u{1f468}‍\u{1f469}‍\u{1f467}'],
  ['a combining mark and Arabic text', 'é مرحبا'],
  ['supplementary plane scalar values', '\u{10000}\u{10ffff}'],
  [
    'lone and swapped surrogates',
    'lone high \ud800 lone low \udc00 swapped \udc00\ud800 trailing high \ud83d',
  ],
];

describe('UTF-8 encoding', () => {
  test.each(samples)('matches the platform encoder for %s', (_description, sample) => {
    expect(encodeUtf8(sample)).toEqual(new TextEncoder().encode(sample));
    expect(utf8ByteLength(sample)).toBe(new TextEncoder().encode(sample).length);
  });

  test('counts bytes, not UTF-16 code units', () => {
    expect('é'.length).toBe(1);
    expect(utf8ByteLength('é')).toBe(2);
    expect('日'.length).toBe(1);
    expect(utf8ByteLength('日')).toBe(3);
    expect('\u{1f600}'.length).toBe(2);
    expect(utf8ByteLength('\u{1f600}')).toBe(4);
  });

  test('replaces a lone surrogate with the replacement character', () => {
    expect([...encodeUtf8('\ud800')]).toEqual([0xef, 0xbf, 0xbd]);
    expect([...encodeUtf8('\udc00')]).toEqual([0xef, 0xbf, 0xbd]);
  });
});
