/**
 * Link and title policy for terminal output, which is hostile bytes. A link is offered only when
 * the host opted in, only for visible `https:` text, and only as the exact text the reader sees.
 * An OSC 8 destination is never read: it is not on screen, so it is not a candidate.
 */

/** The longest address offered as a link, in UTF-16 code units. */
export const MAXIMUM_LINK_LENGTH = 2048;
/** The most rows of one wrapped logical line scanned for links. */
export const MAXIMUM_LINK_ROWS = 32;
/** The most cells of one wrapped logical line scanned for links, across all of its rows. */
export const MAXIMUM_LINK_CELLS = 8192;
/**
 * The most UTF-16 code units of one wrapped logical line scanned for links. A cell holds a base
 * character plus any number of combining marks, so the cell budget does not bound the text.
 */
export const MAXIMUM_LINK_CODE_UNITS = 16_384;
/** The longest terminal title passed to the host, in code points. */
export const MAXIMUM_TITLE_CODE_POINTS = 256;

const CANDIDATE = /https:\/\/[^\s<>"'`\\^{}|]+/giu;
const TRAILING_PUNCTUATION = /[.,;:!?)\]]+$/u;

/** `text` itself when it is a complete, credential-free `https:` address with a host. */
export function parseVisibleHttpsUrl(text: string): string | undefined {
  if (text.length === 0 || text.length > MAXIMUM_LINK_LENGTH) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return undefined;
  }
  const acceptable =
    parsed.protocol === 'https:' &&
    parsed.hostname !== '' &&
    parsed.username === '' &&
    parsed.password === '';
  return acceptable ? text : undefined;
}

export type TextLink = { start: number; end: number; url: string };

/** Visible `https:` addresses in `text`, with the sentence punctuation that follows one removed. */
export function findHttpsLinks(text: string): TextLink[] {
  const links: TextLink[] = [];
  for (const match of text.matchAll(CANDIDATE)) {
    const candidate = match[0].replace(TRAILING_PUNCTUATION, '');
    const url = parseVisibleHttpsUrl(candidate);
    if (url !== undefined) links.push({ start: match.index, end: match.index + url.length, url });
  }
  return links;
}

/** The slice of an engine cell the link scan reads. */
export type LinkCell = { getChars(): string; getWidth(): number };

/** The slice of an engine buffer row the link scan reads. */
export type LinkLine = {
  readonly isWrapped: boolean;
  readonly length: number;
  getCell(column: number): LinkCell | undefined;
};

export type LinkBuffer = {
  readonly length: number;
  getLine(row: number): LinkLine | undefined;
};

/** A link with 1-based inclusive cell coordinates, the shape the engine's link provider takes. */
export type CellLink = {
  url: string;
  range: { start: { x: number; y: number }; end: { x: number; y: number } };
};

type Position = { x: number; y: number };

/**
 * The rows of the wrapped line `row` belongs to, or `undefined` when it spans more rows than the
 * scan allows. The walk stops as soon as the limit is passed, so a line wrapped across the whole
 * scrollback costs a bounded number of reads.
 */
function logicalLineBounds(buffer: LinkBuffer, row: number): [number, number] | undefined {
  let first = row;
  let last = row;
  while (first > 0 && buffer.getLine(first)?.isWrapped === true) {
    first -= 1;
    if (last - first + 1 > MAXIMUM_LINK_ROWS) return undefined;
  }
  while (last + 1 < buffer.length && buffer.getLine(last + 1)?.isWrapped === true) {
    last += 1;
    if (last - first + 1 > MAXIMUM_LINK_ROWS) return undefined;
  }
  return [first, last];
}

/**
 * The links that touch zero-based `row`, found in the whole wrapped line that row belongs to, as
 * 1-based inclusive cell ranges. A wide character contributes its character once and its range
 * covers both cells.
 */
export function linksForRow(buffer: LinkBuffer, row: number): CellLink[] {
  const bounds = logicalLineBounds(buffer, row);
  if (bounds === undefined) return [];
  const [first, last] = bounds;
  // Rows can be 65,535 cells wide, so the row limit alone does not bound the work: count cells
  // from the rows' lengths before any cell is read or any string or position array is built.
  let cells = 0;
  for (let current = first; current <= last; current += 1) {
    cells += buffer.getLine(current)?.length ?? 0;
    if (cells > MAXIMUM_LINK_CELLS) return [];
  }
  let text = '';
  let codeUnits = 0;
  const starts: Position[] = [];
  const ends: Position[] = [];
  for (let current = first; current <= last; current += 1) {
    const line = buffer.getLine(current);
    if (line === undefined) continue;
    for (let column = 0; column < line.length; column += 1) {
      const cell = line.getCell(column);
      if (cell === undefined || cell.getWidth() === 0) continue;
      const chars = cell.getChars() || ' ';
      codeUnits += chars.length;
      if (codeUnits > MAXIMUM_LINK_CODE_UNITS) return [];
      text += chars;
      for (let unit = 0; unit < chars.length; unit += 1) {
        starts.push({ x: column + 1, y: current + 1 });
        ends.push({ x: column + cell.getWidth(), y: current + 1 });
      }
    }
  }
  return findHttpsLinks(text)
    .map(({ start, end, url }): CellLink => ({
      url,
      range: { start: starts[start]!, end: ends[end - 1]! },
    }))
    .filter(({ range }) => range.start.y <= row + 1 && range.end.y >= row + 1);
}

/**
 * Terminal title text safe to show: control characters removed, bounded by code points. It walks
 * the title one code point at a time and stops once it holds the first
 * {@link MAXIMUM_TITLE_CODE_POINTS} printable ones, so the work and the allocation follow the
 * bound rather than the size of a hostile payload.
 */
export function boundTitle(title: string): string {
  let bounded = '';
  let collected = 0;
  for (const character of title) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) continue;
    bounded += character;
    collected += 1;
    if (collected === MAXIMUM_TITLE_CODE_POINTS) break;
  }
  return bounded;
}
