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
        : {
            isWrapped: entry[1],
            length: entry[0].length,
            translateToString: (_trimRight, start = 0, end = entry[0].length) =>
              entry[0].slice(start, end),
          };
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

  test('keeps a blank line at the start', () => {
    expect(projectBuffer(bufferOf(['', false], ['abc', false])).text).toBe('\nabc');
  });

  test('projects an empty buffer as empty text', () => {
    expect(projectBuffer(bufferOf())).toEqual({ text: '', truncated: false, bytes: 0, lines: [] });
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

  test('closes a line left open when the oldest rows are not retained', () => {
    expect(projectBuffer(bufferOf(undefined, ['tail', true])).text).toBe('tail');
  });

  test('reports the byte count of what it returns', () => {
    expect(projectBuffer(bufferOf(['日本', false])).bytes).toBe(6);
  });

  test('says where each whole logical line starts', () => {
    const projection = projectBuffer(
      bufferOf(['one', false], ['wrapped', false], ['-more', true], ['', false], ['end', false]),
    );
    expect(projection.text).toBe('one\nwrapped-more\n\nend');
    expect(projection.lines).toEqual([
      { row: 0, start: 0 },
      { row: 1, start: 4 },
      { row: 3, start: 17 },
      { row: 4, start: 18 },
    ]);
  });
});

describe('keeping the newest content within the byte limit', () => {
  test('keeps whole newest lines and omits earlier ones, with no marker in the text', () => {
    const projection = projectBuffer(
      bufferOf(['first', false], ['second', false], ['third', false]),
      12,
    );
    expect(projection.text).toBe('second\nthird');
    expect(projection.truncated).toBe(true);
    expect(projection.bytes).toBe(12);
  });

  test('starts at a whole line when the next earlier line does not fit', () => {
    const projection = projectBuffer(bufferOf(['aaaaaaaa', false], ['bbbb', false]), 8);
    expect(projection).toEqual({
      text: 'bbbb',
      truncated: true,
      bytes: 4,
      lines: [{ row: 1, start: 0 }],
    });
  });

  test('a limit equal to the content is not a truncation', () => {
    expect(projectBuffer(bufferOf(['abcd', false]), 4).truncated).toBe(false);
    expect(projectBuffer(bufferOf(['ab', false], ['cd', false]), 5).truncated).toBe(false);
  });

  test('a newest line larger than the limit keeps its end, from a whole code point', () => {
    const projection = projectBuffer(bufferOf(['abcdefghij', false]), 4);
    expect(projection).toEqual({ text: 'ghij', truncated: true, bytes: 4, lines: [] });
  });

  test('never starts inside a multi-byte code point', () => {
    // "日" is three bytes: a limit that lands inside one starts at the next whole character.
    expect(projectBuffer(bufferOf(['日a日b', false]), 4).text).toBe('日b');
    expect(projectBuffer(bufferOf(['日a日b', false]), 5).text).toBe('a日b');
    expect(projectBuffer(bufferOf(['日a日b', false]), 3).text).toBe('b');
    expect(projectBuffer(bufferOf(['x\u{1f600}y', false]), 4).text).toBe('y');
    expect(projectBuffer(bufferOf(['x\u{1f600}y', false]), 5).text).toBe('\u{1f600}y');
  });

  test('keeps the end of a soft-wrapped line when the line alone is over the limit', () => {
    const projection = projectBuffer(
      bufferOf(['aaaa', false], ['bbbb', true], ['cccc', true], ['dddd', true]),
      6,
    );
    expect(projection.text).toBe('ccdddd');
    expect(projection.truncated).toBe(true);
  });

  test('keeps a blank line between content that straddles the limit', () => {
    expect(projectBuffer(bufferOf(['ab', false], ['', false], ['cd', false]), 5).text).toBe('\ncd');
    expect(projectBuffer(bufferOf(['ab', false], ['', false], ['cd', false]), 6).text).toBe(
      'ab\n\ncd',
    );
  });

  test('blank rows at the end cost nothing and are not content', () => {
    const rows: Array<readonly [string, boolean]> = [['abcd', false]];
    for (let index = 0; index < 50; index += 1) rows.push(['', false]);
    expect(projectBuffer(bufferOf(...rows), 4)).toEqual({
      text: 'abcd',
      truncated: false,
      bytes: 4,
      lines: [{ row: 0, start: 0 }],
    });
  });

  test('defaults to the 64 KiB accessible-snapshot budget', () => {
    expect(DEFAULT_PROJECTION_BYTE_LIMIT).toBe(65_536);
    const rows = Array.from(
      { length: 100 },
      (_, index) => [`${index}`.padEnd(999, 'x'), false] as const,
    );
    const projection = projectBuffer(bufferOf(...rows));
    expect(projection.truncated).toBe(true);
    expect(projection.bytes).toBeLessThanOrEqual(65_536);
    const kept = projection.text.split('\n');
    expect(kept.at(-1)!.startsWith('99')).toBe(true);
    expect(Number.parseInt(kept[0]!, 10)).toBeGreaterThan(0);
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects the byte limit %p',
    (limit) => {
      expect(() => projectBuffer(bufferOf(['x', false]), limit)).toThrow(RangeError);
    },
  );
});

describe('the work is bounded by the limit, not by the scrollback or a row', () => {
  test('reads only as many rows as the limit needs from a hostile scrollback', () => {
    const rowText = 'x'.repeat(100);
    let linesRead = 0;
    const hostile: ProjectionBuffer = {
      length: 1_000_000,
      getLine() {
        linesRead += 1;
        return {
          isWrapped: false,
          length: rowText.length,
          translateToString: (_trimRight, start = 0, end = rowText.length) =>
            rowText.slice(start, end),
        };
      },
    };
    const projection = projectBuffer(hostile);
    expect(projection.truncated).toBe(true);
    expect(projection.bytes).toBeLessThanOrEqual(DEFAULT_PROJECTION_BYTE_LIMIT);
    // Each row adds 101 bytes, so 64 KiB is reached within about 650 rows, not a million.
    expect(linesRead).toBeLessThanOrEqual(Math.ceil(DEFAULT_PROJECTION_BYTE_LIMIT / 101) + 2);
  });

  test('stops inside one very long soft-wrapped line', () => {
    let linesRead = 0;
    const wrapped: ProjectionBuffer = {
      length: 1_000_000,
      getLine() {
        linesRead += 1;
        const text = 'y'.repeat(1000);
        return {
          isWrapped: true,
          length: text.length,
          translateToString: (_trimRight, start = 0, end = text.length) => text.slice(start, end),
        };
      },
    };
    const projection = projectBuffer(wrapped, 4096);
    expect(projection.truncated).toBe(true);
    expect(projection.bytes).toBe(4096);
    expect(linesRead).toBeLessThanOrEqual(6);
  });

  const COLUMNS = 1_000_000;
  /** A row whose content ends at `end` cells, as a million-cell row of `x` would. */
  function wideRow(end: number, counts: { cells: number }): ProjectionBuffer {
    return {
      length: 1,
      getLine: () => ({
        isWrapped: false,
        length: COLUMNS,
        translateToString: (_trimRight, start = 0, stop = COLUMNS) => {
          const to = Math.min(stop, end);
          const cells = Math.max(0, to - start);
          counts.cells += cells;
          return 'x'.repeat(cells);
        },
      }),
    };
  }

  test('a million-cell row materializes only about the byte limit, found without scanning it', () => {
    const counts = { cells: 0 };
    const projection = projectBuffer(wideRow(COLUMNS, counts), 1024);
    expect(projection.truncated).toBe(true);
    expect(projection.text).toBe('x'.repeat(1024));
    expect(counts.cells).toBeLessThanOrEqual(1024 + 256 + 64);
  });

  test('a wide row with little content reads only that content', () => {
    const counts = { cells: 0 };
    const projection = projectBuffer(wideRow(10, counts), 1024);
    expect(projection.text).toBe('x'.repeat(10));
    expect(projection.truncated).toBe(false);
    expect(counts.cells).toBeLessThanOrEqual(10 + 64);
  });

  test('a blank wide row is found blank without scanning it', () => {
    const counts = { cells: 0 };
    expect(projectBuffer(wideRow(0, counts), 1024).text).toBe('');
    expect(counts.cells).toBe(0);
  });

  test('a row read in slices projects exactly what one whole read would', () => {
    const text = `${'ab '.repeat(300)}end`;
    expect(projectBuffer(bufferOf([text, false], ['tail', false])).text).toBe(`${text}\ntail`);
  });

  test('a cut inside a multibyte character in an earlier slice still starts on a code point', () => {
    const projection = projectBuffer(bufferOf(['日日日' + 'a'.repeat(255), false]), 258);
    expect(projection.text).toBe('日' + 'a'.repeat(255));
    expect(projection.bytes).toBe(258);
  });

  test('never asks for more cells than the limit needs when every cell carries combining marks', () => {
    const marks = '́'.repeat(1000);
    let widest = 0;
    const buffer: ProjectionBuffer = {
      length: 1,
      getLine: () => ({
        isWrapped: false,
        length: 100_000,
        translateToString: (_trimRight, start = 0, end = 100_000) => {
          const cells = Math.max(0, Math.min(end, 100_000) - start);
          widest = Math.max(widest, cells);
          return `a${marks}`.repeat(cells);
        },
      }),
    };
    const projection = projectBuffer(buffer, 8);
    expect(projection.truncated).toBe(true);
    expect(projection.bytes).toBeLessThanOrEqual(8);
    expect(widest).toBeLessThanOrEqual(256);
  });
});
