import { describe, expect, it } from 'bun:test';

import { utf8ByteLength } from './json-rpc-websocket-validation.ts';

describe('utf8ByteLength', () => {
  const samples: [description: string, sample: string][] = [
    ['an empty string', ''],
    ['plain ASCII text', 'plain ascii'],
    ['an accented Latin character', 'é'],
    ['accented Latin text', 'héllo wörld'],
    ['Japanese text', '日本語'],
    ['an emoji', '😀'],
    ['ASCII text around an emoji', 'a😀b'],
    ['a lone high surrogate', '\ud800'],
    ['a lone low surrogate', '\udc00'],
    ['an embedded lone high surrogate', 'a\ud800b'],
    ['a reversed surrogate pair', '\udc00\ud800'],
    ['an emoji with a trailing high surrogate', '😀\ud83d'],
    ['control and boundary scalar values', '\u0000\u007f\u0080߿ࠀ￿'],
  ];

  for (const [description, sample] of samples) {
    it(`measures ${description} as Buffer.byteLength does`, () => {
      expect(utf8ByteLength(sample)).toBe(Buffer.byteLength(sample, 'utf8'));
    });
  }
});
