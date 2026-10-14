import { describe, expect, test } from 'bun:test';

import {
  MAXIMUM_LINK_CELLS,
  MAXIMUM_LINK_LENGTH,
  MAXIMUM_LINK_ROWS,
  MAXIMUM_TITLE_CODE_POINTS,
  boundTitle,
  findHttpsLinks,
  linksForRow,
  parseVisibleHttpsUrl,
  type LinkBuffer,
} from './terminal-links.ts';

describe('parseVisibleHttpsUrl', () => {
  test('accepts a plain https address and returns the visible text unchanged', () => {
    expect(parseVisibleHttpsUrl('https://example.test/a?b=c#d')).toBe(
      'https://example.test/a?b=c#d',
    );
  });

  test.each([
    ['http', 'http://example.test/'],
    ['file', 'file:///etc/passwd'],
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html,<b>x</b>'],
    ['ssh', 'ssh://host/'],
    ['a path', '/etc/passwd'],
    ['a relative path', '../secret'],
    ['credentials', 'https://user:secret@example.test/'],
    ['a user', 'https://user@example.test/'],
    ['no host', 'https://'],
    ['empty text', ''],
    ['not a URL', 'https:// not a url'],
  ])('rejects %s', (_name, text) => {
    expect(parseVisibleHttpsUrl(text)).toBeUndefined();
  });

  test('rejects an address longer than the limit', () => {
    const long = `https://example.test/${'a'.repeat(MAXIMUM_LINK_LENGTH)}`;
    expect(parseVisibleHttpsUrl(long)).toBeUndefined();
  });
});

describe('link scan work is bounded', () => {
  function countingBuffer(rows: number, columns: number, wrapped = true) {
    const counts = { lines: 0, cells: 0 };
    const buffer: LinkBuffer = {
      length: rows,
      getLine() {
        counts.lines += 1;
        return {
          isWrapped: wrapped,
          length: columns,
          getCell() {
            counts.cells += 1;
            return { getChars: () => 'a', getWidth: () => 1 };
          },
        };
      },
    };
    return { buffer, counts };
  }

  test('a wrapped line of enormous rows is refused before any cell is read', () => {
    const { buffer, counts } = countingBuffer(32, 65_535);
    expect(linksForRow(buffer, 10)).toEqual([]);
    expect(counts.cells).toBe(0);
  });

  test('a wrapped line spanning many thousands of rows reads about the row limit', () => {
    const { buffer, counts } = countingBuffer(100_000, 80);
    expect(linksForRow(buffer, 50_000)).toEqual([]);
    expect(counts.cells).toBe(0);
    expect(counts.lines).toBeLessThanOrEqual(2 * MAXIMUM_LINK_ROWS + 2);
  });

  test('a line within the cell budget is still scanned', () => {
    const { buffer, counts } = countingBuffer(1, MAXIMUM_LINK_CELLS);
    expect(linksForRow(buffer, 0)).toEqual([]);
    expect(counts.cells).toBe(MAXIMUM_LINK_CELLS);
  });

  test('one cell over the budget is refused without reading cells', () => {
    const { buffer, counts } = countingBuffer(1, MAXIMUM_LINK_CELLS + 1);
    expect(linksForRow(buffer, 0)).toEqual([]);
    expect(counts.cells).toBe(0);
  });
});

describe('findHttpsLinks', () => {
  test('finds each visible address with its offsets', () => {
    const text = 'see https://a.test/x and https://b.test/y now';
    expect(findHttpsLinks(text)).toEqual([
      { start: 4, end: 20, url: 'https://a.test/x' },
      { start: 25, end: 41, url: 'https://b.test/y' },
    ]);
  });

  test('leaves sentence punctuation out of the link', () => {
    expect(findHttpsLinks('(see https://a.test/x).').map((link) => link.url)).toEqual([
      'https://a.test/x',
    ]);
    expect(
      findHttpsLinks('go: https://a.test/x, then https://b.test/y!').map((l) => l.url),
    ).toEqual(['https://a.test/x', 'https://b.test/y']);
  });

  test('ignores unsafe schemes, paths, and credentials in surrounding text', () => {
    const text =
      'file:///etc/passwd /usr/bin/env http://a.test/ https://u:p@a.test/ javascript:alert(1)';
    expect(findHttpsLinks(text)).toEqual([]);
  });

  test('stops at markup and quoting characters', () => {
    expect(findHttpsLinks('<a href="https://a.test/x">').map((l) => l.url)).toEqual([
      'https://a.test/x',
    ]);
  });
});

type Row = { text: string; wrapped?: boolean };

/** A buffer of `columns`-wide rows. `日` takes two cells, the second reported empty. */
function bufferOf(columns: number, ...rows: Row[]): LinkBuffer {
  return {
    length: rows.length,
    getLine(index) {
      const row = rows[index];
      if (row === undefined) return undefined;
      const cells: Array<{ chars: string; width: number }> = [];
      for (const character of row.text) {
        const wide = character === '日';
        cells.push({ chars: character, width: wide ? 2 : 1 });
        if (wide) cells.push({ chars: '', width: 0 });
      }
      while (cells.length < columns) cells.push({ chars: '', width: 1 });
      return {
        isWrapped: row.wrapped === true,
        length: columns,
        getCell: (column) => {
          const cell = cells[column];
          return cell === undefined
            ? undefined
            : { getChars: () => cell.chars, getWidth: () => cell.width };
        },
      };
    },
  };
}

describe('linksForRow', () => {
  test('returns a link with its 1-based inclusive cell range', () => {
    const buffer = bufferOf(30, { text: 'go https://a.test/x ok' });
    expect(linksForRow(buffer, 0)).toEqual([
      {
        url: 'https://a.test/x',
        range: { start: { x: 4, y: 1 }, end: { x: 19, y: 1 } },
      },
    ]);
  });

  test('finds a link that wraps across rows from either row', () => {
    const buffer = bufferOf(10, { text: 'https://ex' }, { text: 'ample.test', wrapped: true });
    const expected = {
      url: 'https://example.test',
      range: { start: { x: 1, y: 1 }, end: { x: 10, y: 2 } },
    };
    expect(linksForRow(buffer, 0)).toEqual([expected]);
    expect(linksForRow(buffer, 1)).toEqual([expected]);
  });

  test('does not offer a link from another row of the buffer', () => {
    const buffer = bufferOf(30, { text: 'https://a.test/x' }, { text: 'plain text' });
    expect(linksForRow(buffer, 1)).toEqual([]);
  });

  test('counts a wide character once and covers both of its cells', () => {
    const buffer = bufferOf(30, { text: '日 https://a.test/x' });
    expect(linksForRow(buffer, 0)[0]?.range).toEqual({
      start: { x: 4, y: 1 },
      end: { x: 19, y: 1 },
    });
  });

  test('skips a row the engine no longer retains', () => {
    const base = bufferOf(30, { text: 'https://a.test/x' });
    const gapped: LinkBuffer = {
      length: 2,
      getLine: (row) => (row === 0 ? base.getLine(0) : undefined),
    };
    expect(linksForRow(gapped, 0)).toHaveLength(1);
  });

  test('skips a cell the engine does not report', () => {
    const row = bufferOf(30, { text: 'https://a.test/x' }).getLine(0)!;
    const sparse: LinkBuffer = {
      length: 1,
      getLine: () => ({ ...row, length: 40, getCell: (column) => row.getCell(column) }),
    };
    expect(linksForRow(sparse, 0)).toHaveLength(1);
  });

  test('refuses to scan a wrapped line longer than the row limit', () => {
    const rows: Row[] = Array.from({ length: MAXIMUM_LINK_ROWS + 1 }, (_, index) => ({
      text: 'https://a.test/x',
      wrapped: index > 0,
    }));
    expect(linksForRow(bufferOf(20, ...rows), 5)).toEqual([]);
    expect(
      linksForRow(bufferOf(20, ...rows.slice(0, MAXIMUM_LINK_ROWS)), 5).length,
    ).toBeGreaterThan(0);
  });
});

describe('boundTitle', () => {
  test('keeps printable text', () => {
    expect(boundTitle('user@host: ~/project — 日本語')).toBe('user@host: ~/project — 日本語');
  });

  test('removes control characters and escape sequences leaving no markup behind', () => {
    expect(boundTitle('a\u001b[31mb\u0007c\u0000d\u007fe\u0085f')).toBe('a[31mbcdef');
  });

  test('keeps markup as inert text', () => {
    expect(boundTitle('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');
  });

  test('bounds by code points without splitting a surrogate pair', () => {
    const title = '\u{1f600}'.repeat(MAXIMUM_TITLE_CODE_POINTS + 10);
    const bounded = boundTitle(title);
    expect(Array.from(bounded)).toHaveLength(MAXIMUM_TITLE_CODE_POINTS);
    expect(bounded).toBe('\u{1f600}'.repeat(MAXIMUM_TITLE_CODE_POINTS));
  });
});
