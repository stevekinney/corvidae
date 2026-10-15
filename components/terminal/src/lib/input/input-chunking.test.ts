import { describe, expect, test } from 'bun:test';

import { planInputChunks } from './input-chunking.ts';

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);
const decoder = new TextDecoder();

function joined(chunks: Uint8Array[]): string {
  return chunks.map((chunk) => decoder.decode(chunk)).join('');
}

describe('planInputChunks', () => {
  test('keeps input within the limit as a single operation', () => {
    const plan = planInputChunks(bytes('hello'), 5)!;
    expect(plan).toHaveLength(1);
    expect(joined(plan)).toBe('hello');
  });

  test('plans an empty input as one empty operation', () => {
    const plan = planInputChunks(new Uint8Array(0), 8)!;
    expect(plan).toHaveLength(1);
    expect(plan[0]!.length).toBe(0);
  });

  test('splits plain text at the limit and reassembles it exactly', () => {
    const plan = planInputChunks(bytes('abcdefghij'), 4)!;
    expect(plan.map((chunk) => chunk.length)).toEqual([4, 4, 2]);
    expect(joined(plan)).toBe('abcdefghij');
  });

  test('never cuts inside a multibyte character', () => {
    // Each of these is three bytes; a limit of four must still cut between characters.
    const plan = planInputChunks(bytes('あいう😀'), 4)!;
    expect(plan.map((chunk) => decoder.decode(chunk))).toEqual(['あ', 'い', 'う', '😀']);
    for (const chunk of plan) expect(chunk.length).toBeLessThanOrEqual(4);
  });

  test('measures two-byte and four-byte characters by their own length', () => {
    expect(planInputChunks(bytes('éé😀'), 4)!.map((chunk) => decoder.decode(chunk))).toEqual([
      'éé',
      '😀',
    ]);
  });

  test('keeps the bracketed-paste markers whole', () => {
    const text = '\u001b[200~abc\u001b[201~';
    const plan = planInputChunks(bytes(text), 8)!;
    expect(plan.map((chunk) => decoder.decode(chunk))).toEqual(['\u001b[200~ab', 'c\u001b[201~']);
    expect(planInputChunks(bytes(text), 6)!.map((chunk) => decoder.decode(chunk))).toEqual([
      '\u001b[200~',
      'abc',
      '\u001b[201~',
    ]);
  });

  test('keeps a CSI sequence with parameters and intermediates whole', () => {
    const plan = planInputChunks(bytes('a\u001b[1;2 qb'), 8)!;
    expect(plan.map((chunk) => decoder.decode(chunk))).toEqual(['a\u001b[1;2 q', 'b']);
  });

  test('keeps OSC, DCS, SOS, PM and APC strings whole to BEL or ST', () => {
    const osc = '\u001b]0;title\u0007';
    expect(planInputChunks(bytes(`${osc}x`), osc.length)!.map((c) => decoder.decode(c))).toEqual([
      osc,
      'x',
    ]);
    for (const introducer of ['P', 'X', '^', '_']) {
      const string = `\u001b${introducer}payload\u001b\\`;
      expect(
        planInputChunks(bytes(`${string}y`), string.length)!.map((c) => decoder.decode(c)),
      ).toEqual([string, 'y']);
    }
  });

  test('keeps a short escape with intermediates whole', () => {
    const plan = planInputChunks(bytes('\u001b(0z'), 4)!;
    expect(plan.map((chunk) => decoder.decode(chunk))).toEqual(['\u001b(0z']);
    expect(planInputChunks(bytes('a\u001b=b'), 2)!.map((c) => decoder.decode(c))).toEqual([
      'a',
      '\u001b=',
      'b',
    ]);
  });

  test('treats an ESC that introduces nothing as a single byte', () => {
    expect(planInputChunks(bytes('\u001b\u001b\r'), 1)!.map((c) => c.length)).toEqual([1, 1, 1]);
    expect(planInputChunks(bytes('\u001bあ'), 1)).toBeUndefined();
    expect(planInputChunks(bytes('\u001b'), 1)!.map((c) => c.length)).toEqual([1]);
  });

  test('ends an unterminated sequence at its last byte, or where the sequence breaks', () => {
    expect(planInputChunks(bytes('\u001b[12'), 4)!.map((c) => decoder.decode(c))).toEqual([
      '\u001b[12',
    ]);
    // A CSI cut off by a control byte ends before it.
    expect(planInputChunks(bytes('\u001b[1\rx'), 3)!.map((c) => decoder.decode(c))).toEqual([
      '\u001b[1',
      '\rx',
    ]);
    expect(planInputChunks(bytes('\u001b]no terminator'), 40)!).toHaveLength(1);
    expect(planInputChunks(bytes('\u001b('), 2)!.map((c) => c.length)).toEqual([2]);
  });

  test('fails when one atom cannot fit, and plans nothing', () => {
    expect(planInputChunks(bytes('\u001b[200~'), 5)).toBeUndefined();
    expect(planInputChunks(bytes('😀'), 3)).toBeUndefined();
    expect(planInputChunks(bytes('ok\u001b]0;a very long title\u0007'), 8)).toBeUndefined();
  });

  test('fails closed for a limit that is not a positive integer', () => {
    for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(planInputChunks(bytes('a'), limit)).toBeUndefined();
    }
  });

  test('copies each chunk so the caller may reuse its buffer', () => {
    const source = bytes('abcd');
    const plan = planInputChunks(source, 2)!;
    source.fill(0x7a);
    expect(joined(plan)).toBe('abcd');
  });
});
