import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_PROJECTION_BYTE_LIMIT,
  projectBuffer,
  type ProjectionBuffer,
} from './terminal-projection.ts';

/** Rows as the engine reports them: `[text, wrappedFromPreviousRow]`. */
function bufferOf(...rows: Array<readonly [string, boolean] | undefined>): ProjectionBuffer {
  return {
    length: rows.length,
    getLine(row) {
      const entry = rows[row];
      return entry === undefined
        ? undefined
        : { isWrapped: entry[1], translateToString: () => entry[0] };
    },
  };
}

describe('projectBuffer', () => {
  test('keeps hard line boundaries as LF', () => {
    const projection = projectBuffer(bufferOf(['one', false], ['two', false], ['three', false]));
    expect(projection.text).toBe('one\ntwo\nthree');
    expect(projection.truncated).toBe(false);
  });

  test('joins a soft wrap without inserting a separator', () => {
    const projection = projectBuffer(
      bufferOf(['1234567890', false], ['abcdefghij', true], ['xyz', true], ['next', false]),
    );
    expect(projection.text).toBe('1234567890abcdefghijxyz\nnext');
  });

  test('keeps a space that sits at the wrap point', () => {
    expect(projectBuffer(bufferOf(['bbbb ', false], ['c', true])).text).toBe('bbbb c');
  });

  test('adds nothing for wide characters, whose continuation cells the engine reports empty', () => {
    expect(projectBuffer(bufferOf(['日本語', false], ['한글', true])).text).toBe('日本語한글');
  });

  test('keeps blank lines between content and drops the blank tail', () => {
    const projection = projectBuffer(
      bufferOf(['top', false], ['', false], ['bottom', false], ['', false], ['', false]),
    );
    expect(projection.text).toBe('top\n\nbottom');
  });

  test('projects an empty buffer as empty text', () => {
    expect(projectBuffer(bufferOf())).toEqual({
      text: '',
      truncated: false,
      bytes: 0,
    });
    expect(projectBuffer(bufferOf(['', false], ['', false])).text).toBe('');
  });

  test('skips a row the engine no longer retains', () => {
    expect(projectBuffer(bufferOf(['one', false], undefined, ['two', false])).text).toBe(
      'one\ntwo',
    );
  });

  test('starts a logical line when the first retained row claims to be wrapped', () => {
    expect(projectBuffer(bufferOf(['tail', true], ['next', false])).text).toBe('tail\nnext');
  });

  test('reports the byte count of what it returns', () => {
    const projection = projectBuffer(bufferOf(['日本', false]));
    expect(projection.bytes).toBe(6);
  });

  test('truncates at the byte limit', () => {
    const projection = projectBuffer(bufferOf(['abcdefghij', false]), 4);
    expect(projection).toEqual({ text: 'abcd', truncated: true, bytes: 4 });
  });

  test('never splits a multi-byte code point when it truncates', () => {
    // "日" is three bytes, so "a日" needs 4 and "a日b" needs 5.
    expect(projectBuffer(bufferOf(['a日b', false]), 4).text).toBe('a日');
    expect(projectBuffer(bufferOf(['a日b', false]), 3).text).toBe('a');
    expect(projectBuffer(bufferOf(['a日b', false]), 2).text).toBe('a');
    expect(projectBuffer(bufferOf(['\u{1f600}x', false]), 3).text).toBe('');
    expect(projectBuffer(bufferOf(['\u{1f600}x', false]), 4).text).toBe('\u{1f600}');
  });

  test('a limit equal to the content is not a truncation', () => {
    const projection = projectBuffer(bufferOf(['abcd', false]), 4);
    expect(projection.truncated).toBe(false);
  });

  test('defaults to the 64 KiB accessible-snapshot budget', () => {
    expect(DEFAULT_PROJECTION_BYTE_LIMIT).toBe(65_536);
    const big = bufferOf(...Array.from({ length: 100 }, () => ['x'.repeat(1000), false] as const));
    const projection = projectBuffer(big);
    expect(projection.truncated).toBe(true);
    expect(projection.bytes).toBe(65_536);
  });

  test('reads only as many rows and cells as the limit needs from a hostile scrollback', () => {
    const rowText = 'x'.repeat(100);
    let linesRead = 0;
    let rowsTranslated = 0;
    const hostile: ProjectionBuffer = {
      length: 1_000_000,
      getLine() {
        linesRead += 1;
        return {
          isWrapped: false,
          translateToString() {
            rowsTranslated += 1;
            return rowText;
          },
        };
      },
    };
    const projection = projectBuffer(hostile);
    expect(projection.truncated).toBe(true);
    expect(projection.bytes).toBe(DEFAULT_PROJECTION_BYTE_LIMIT);
    // Each row adds 101 bytes, so 64 KiB is reached within 650 rows, not a million.
    expect(linesRead).toBeLessThanOrEqual(Math.ceil(DEFAULT_PROJECTION_BYTE_LIMIT / 101) + 2);
    expect(rowsTranslated).toBe(linesRead);
  });

  test('stops at the limit inside one very long soft-wrapped line', () => {
    let linesRead = 0;
    const wrapped: ProjectionBuffer = {
      length: 1_000_000,
      getLine() {
        linesRead += 1;
        return { isWrapped: true, translateToString: () => 'y'.repeat(1000) };
      },
    };
    const projection = projectBuffer(wrapped, 4096);
    expect(projection.truncated).toBe(true);
    expect(projection.bytes).toBe(4096);
    expect(linesRead).toBeLessThanOrEqual(6);
  });

  test('blank rows after the limit cost nothing and are not a truncation', () => {
    const rows: Array<readonly [string, boolean]> = [['abcd', false]];
    for (let index = 0; index < 50; index += 1) rows.push(['', false]);
    const projection = projectBuffer(bufferOf(...rows), 4);
    expect(projection).toEqual({ text: 'abcd', truncated: false, bytes: 4 });
  });

  test('keeps a blank line between content that straddles the limit', () => {
    expect(projectBuffer(bufferOf(['ab', false], ['', false], ['cd', false]), 5).text).toBe(
      'ab\n\nc',
    );
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects the byte limit %p',
    (limit) => {
      expect(() => projectBuffer(bufferOf(['x', false]), limit)).toThrow(RangeError);
    },
  );
});
