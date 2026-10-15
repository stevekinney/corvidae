import { describe, expect, test } from 'bun:test';

import { locateRange, type LocateBuffer, type LocateCell } from './terminal-locate.ts';
import type { TerminalProjection } from './terminal-projection.ts';

type Row = { cells: Array<LocateCell | undefined>; wrapped: boolean; text?: string };

const cell = (chars: string, width = 1): LocateCell => ({
  getChars: () => chars,
  getWidth: () => width,
});

/** A row of single-width cells, one per character. */
function row(text: string, wrapped = false, columns = text.length): Row {
  const cells: Array<LocateCell | undefined> = Array.from(text, (character) => cell(character));
  while (cells.length < columns) cells.push(cell(''));
  return { cells, wrapped, text };
}

function bufferOf(...rows: Array<Row | undefined>): LocateBuffer {
  return {
    length: rows.length,
    getLine(index) {
      const entry = rows[index];
      if (entry === undefined) return undefined;
      return {
        isWrapped: entry.wrapped,
        length: entry.cells.length,
        translateToString: () => entry.text ?? '',
        getCell: (column) => entry.cells[column],
      };
    },
  };
}

function projectionOf(
  text: string,
  lines: Array<{ row: number; start: number }>,
): TerminalProjection {
  return { text, truncated: false, bytes: text.length, lines };
}

describe('locateRange', () => {
  test('places a range inside one row', () => {
    const buffer = bufferOf(row('hello world', false, 20));
    const projection = projectionOf('hello world', [{ row: 0, start: 0 }]);
    expect(locateRange(buffer, projection, 20, { start: 6, end: 11 })).toEqual({
      column: 6,
      row: 0,
      length: 5,
    });
  });

  test('places a range that continues across a soft wrap as one run of cells', () => {
    const buffer = bufferOf(row('abcdefgh', false), row('ijkl', true, 8));
    const projection = projectionOf('abcdefghijkl', [{ row: 0, start: 0 }]);
    expect(locateRange(buffer, projection, 8, { start: 6, end: 10 })).toEqual({
      column: 6,
      row: 0,
      length: 4,
    });
  });

  test('places a range that crosses a hard line break, including the cells between the rows', () => {
    const buffer = bufferOf(row('one', false, 8), row('two', false, 8));
    const projection = projectionOf('one\ntwo', [
      { row: 0, start: 0 },
      { row: 1, start: 4 },
    ]);
    expect(locateRange(buffer, projection, 8, { start: 1, end: 6 })).toEqual({
      column: 1,
      row: 0,
      length: 9,
    });
  });

  test('a width-two character counts once in the text and fills two cells', () => {
    const wide: Row = {
      cells: [cell('日', 2), cell('', 0), cell('x'), cell('')],
      wrapped: false,
      text: '日x',
    };
    const buffer = bufferOf(wide);
    const projection = projectionOf('日x', [{ row: 0, start: 0 }]);
    expect(locateRange(buffer, projection, 4, { start: 1, end: 2 })).toEqual({
      column: 2,
      row: 0,
      length: 1,
    });
    expect(locateRange(buffer, projection, 4, { start: 0, end: 2 })).toEqual({
      column: 0,
      row: 0,
      length: 3,
    });
  });

  test('a range ending at the last character of a row ends after its continuation cell', () => {
    const wide: Row = {
      cells: [cell('x'), cell('日', 2), cell('', 0), cell('')],
      wrapped: false,
      text: 'x日',
    };
    const projection = projectionOf('x日', [{ row: 0, start: 0 }]);
    expect(locateRange(bufferOf(wide), projection, 4, { start: 0, end: 2 })).toEqual({
      column: 0,
      row: 0,
      length: 3,
    });
  });

  test('an unwritten gap inside content counts as one space', () => {
    const gap: Row = {
      cells: [cell('a'), cell(''), cell('b'), cell('')],
      wrapped: false,
      text: 'a b',
    };
    const projection = projectionOf('a b', [{ row: 0, start: 0 }]);
    expect(locateRange(bufferOf(gap), projection, 4, { start: 2, end: 3 })).toEqual({
      column: 2,
      row: 0,
      length: 1,
    });
  });

  test('cannot place a range that starts inside one cell’s characters', () => {
    const combined: Row = { cells: [cell('é'), cell('x')], wrapped: false, text: 'éx' };
    const projection = projectionOf('éx', [{ row: 0, start: 0 }]);
    expect(locateRange(bufferOf(combined), projection, 2, { start: 1, end: 3 })).toBeUndefined();
  });

  test('cannot place a range whose end falls inside one cell’s characters', () => {
    const combined: Row = { cells: [cell('xé'), cell('y')], wrapped: false, text: 'xéy' };
    const projection = projectionOf('xéy', [{ row: 0, start: 0 }]);
    expect(locateRange(bufferOf(combined), projection, 2, { start: 0, end: 2 })).toBeUndefined();
  });

  test('cannot place a range before the first whole line, such as a cut newest line', () => {
    const buffer = bufferOf(row('abcdef', false));
    const projection = projectionOf('cdef', []);
    expect(locateRange(buffer, projection, 6, { start: 0, end: 2 })).toBeUndefined();
    const later = projectionOf('xx\nabc', [{ row: 0, start: 3 }]);
    expect(locateRange(buffer, later, 6, { start: 0, end: 2 })).toBeUndefined();
  });

  test('cannot place a range past the end of its line', () => {
    const buffer = bufferOf(row('ab', false, 4));
    const projection = projectionOf('ab', [{ row: 0, start: 0 }]);
    expect(locateRange(buffer, projection, 4, { start: 0, end: 9 })).toBeUndefined();
  });

  test('cannot place a range when a row is no longer retained or no longer continues the line', () => {
    const projection = projectionOf('abcdef', [{ row: 0, start: 0 }]);
    expect(
      locateRange(bufferOf(row('abc', false), undefined), projection, 3, { start: 1, end: 5 }),
    ).toBeUndefined();
    expect(
      locateRange(bufferOf(row('abc', false), row('def', false)), projection, 3, {
        start: 1,
        end: 5,
      }),
    ).toBeUndefined();
    expect(locateRange(bufferOf(undefined), projection, 3, { start: 0, end: 2 })).toBeUndefined();
  });

  test('cannot place a range when the buffer holds fewer rows than the projection described', () => {
    const projection = projectionOf('abcdef', [{ row: 0, start: 0 }]);
    expect(
      locateRange(bufferOf(row('abc', false)), projection, 3, { start: 4, end: 5 }),
    ).toBeUndefined();
  });

  test('cannot place a range when a cell is missing', () => {
    const missing: Row = { cells: [cell('a'), undefined], wrapped: false, text: 'ab' };
    const projection = projectionOf('ab', [{ row: 0, start: 0 }]);
    expect(locateRange(bufferOf(missing), projection, 2, { start: 1, end: 2 })).toBeUndefined();
  });

  test('cannot place an empty range', () => {
    const buffer = bufferOf(row('abc', false, 6));
    const projection = projectionOf('abc', [{ row: 0, start: 0 }]);
    expect(locateRange(buffer, projection, 6, { start: 2, end: 2 })).toBeUndefined();
  });

  test('walks past rows that are empty', () => {
    const buffer = bufferOf(row('ab', false, 4), row('', true, 4), row('cd', true, 4));
    const projection = projectionOf('abcd', [{ row: 0, start: 0 }]);
    expect(locateRange(buffer, projection, 4, { start: 2, end: 4 })).toEqual({
      column: 0,
      row: 2,
      length: 2,
    });
  });
});
