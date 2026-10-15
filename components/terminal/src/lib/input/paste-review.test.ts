import { describe, expect, test } from 'bun:test';

import { DEFAULT_MAXIMUM_PASTE_BYTES, MAXIMUM_PASTE_BYTES } from './input-types.ts';
import {
  analyzePaste,
  renderVisibleControls,
  resolvePasteLimit,
  reviewPaste,
} from './paste-review.ts';

describe('analyzePaste', () => {
  test('lets a plain single line through without review', () => {
    const analysis = analyzePaste('echo hello', 100);
    expect(analysis).toMatchObject({
      bytes: 10,
      lines: 1,
      hasNewline: false,
      endsWithNewline: false,
      controlCount: 0,
      needsReview: false,
      tooLarge: false,
    });
  });

  test('flags a trailing newline, which would run the last line', () => {
    const analysis = analyzePaste('ls\n', 100);
    expect(analysis.endsWithNewline).toBe(true);
    expect(analysis.needsReview).toBe(true);
    expect(analysis.lines).toBe(1);
  });

  test('counts lines for LF, CR and CRLF, treating CRLF as one break', () => {
    expect(analyzePaste('a\nb\nc', 100).lines).toBe(3);
    expect(analyzePaste('a\rb', 100).lines).toBe(2);
    expect(analyzePaste('a\r\nb\r\n', 100).lines).toBe(2);
    expect(analyzePaste('\n', 100).lines).toBe(1);
    expect(analyzePaste('', 100).lines).toBe(0);
  });

  test('counts C0, DEL and C1 controls but not line breaks', () => {
    expect(analyzePaste('a\u001bb\u0007c\u007f\u0085', 100).controlCount).toBe(4);
    expect(analyzePaste('a\tb', 100).controlCount).toBe(1);
    expect(analyzePaste('a\r\nb', 100).controlCount).toBe(0);
    expect(analyzePaste('a\u001b[31mred', 100).needsReview).toBe(true);
    expect(analyzePaste('é😀', 100).controlCount).toBe(0);
  });

  test('measures UTF-8 bytes against the limit, never the UTF-16 length', () => {
    expect(analyzePaste('あ', 100).bytes).toBe(3);
    expect(analyzePaste('あいう', 9).tooLarge).toBe(false);
    expect(analyzePaste('あいう', 8).tooLarge).toBe(true);
  });

  test('notices a pasted bracketed-paste terminator', () => {
    expect(analyzePaste('x\u001b[201~rm -rf', 100).containsPasteTerminator).toBe(true);
    expect(analyzePaste('x\u001b[200~y', 100).containsPasteTerminator).toBe(false);
  });
});

describe('renderVisibleControls', () => {
  test('shows line breaks with their pictures and keeps the lines', () => {
    expect(renderVisibleControls('a\nb')).toBe('a␊\nb');
    expect(renderVisibleControls('a\r\nb')).toBe('a␍␊\nb');
    expect(renderVisibleControls('a\rb')).toBe('a␍\nb');
    expect(renderVisibleControls('ls\n')).toBe('ls␊\n');
  });

  test('shows controls as control pictures and C1 as code points', () => {
    expect(renderVisibleControls('\u001b[0m\u0003\t')).toBe('␛[0m␃␉');
    expect(renderVisibleControls('\u007f')).toBe('␡');
    expect(renderVisibleControls('\u0085\u009f')).toBe('⟦U+0085⟧⟦U+009F⟧');
  });

  test('leaves printable text, including non-ASCII, untouched', () => {
    expect(renderVisibleControls('héllo 😀 あ')).toBe('héllo 😀 あ');
  });
});

describe('reviewPaste', () => {
  test('keeps the exact text and describes it', () => {
    const review = reviewPaste('one\ntwo\n', 100, true);
    expect(review).toMatchObject({
      bracketedPaste: true,
      kind: 'confirm',
      text: 'one\ntwo\n',
      visibleText: 'one␊\ntwo␊\n',
      bytes: 8,
      lines: 2,
      endsWithNewline: true,
      controlCount: 0,
      containsPasteTerminator: false,
      maximumBytes: 100,
    });
  });

  test('rejects a paste over the limit and keeps none of its text', () => {
    const review = reviewPaste('x'.repeat(11), 10, false);
    expect(review).toEqual({ kind: 'rejected', bytes: 11, maximumBytes: 10 });
    expect('text' in review).toBe(false);
  });

  test('accepts a paste exactly at the limit', () => {
    expect(reviewPaste('x'.repeat(10), 10, false).kind).toBe('confirm');
  });
});

describe('resolvePasteLimit', () => {
  test('accepts an integer in the permitted range', () => {
    expect(resolvePasteLimit(1)).toBe(1);
    expect(resolvePasteLimit(4096)).toBe(4096);
    expect(resolvePasteLimit(MAXIMUM_PASTE_BYTES)).toBe(MAXIMUM_PASTE_BYTES);
  });

  test('falls back to the 64 KiB default for anything else', () => {
    expect(DEFAULT_MAXIMUM_PASTE_BYTES).toBe(65_536);
    for (const bad of [
      undefined,
      null,
      '4096',
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      MAXIMUM_PASTE_BYTES + 1,
    ]) {
      expect(resolvePasteLimit(bad)).toBe(DEFAULT_MAXIMUM_PASTE_BYTES);
    }
  });
});
