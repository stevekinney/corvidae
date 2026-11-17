import { describe, expect, it } from 'bun:test';

import { utf8ByteLength } from './json-rpc-websocket-validation.ts';

describe('utf8ByteLength', () => {
  const samples = [
    '',
    'plain ascii',
    'é',
    'héllo wörld',
    '日本語',
    '😀',
    'a😀b',
    '\ud800',
    '\udc00',
    'a\ud800b',
    '\udc00\ud800',
    '😀\ud83d',
    '\u0000\u007f\u0080߿ࠀ￿',
  ];

  for (const sample of samples) {
    it(`measures ${JSON.stringify(sample)} as Buffer.byteLength does`, () => {
      expect(utf8ByteLength(sample)).toBe(Buffer.byteLength(sample, 'utf8'));
    });
  }
});
