import { SEARCH_MATCH_LIMIT, SEARCH_QUERY_CODE_POINT_LIMIT } from './inspection-types.ts';

/**
 * Search over a snapshot of the retained output. A query is a literal sequence of code points
 * matched exactly: case matters, no Unicode normalization is applied (`é` and `e` plus a combining
 * acute are different), there is no regular expression, and a line feed may be part of the query.
 * The text it searches is the joined projection, so a soft wrap is invisible to it and a hard line
 * break is a single `\n`.
 */

/** A match, as UTF-16 offsets into the searched text. */
export type Match = { start: number; end: number };

export type SearchResult = {
  matches: Match[];
  /** More than {@link SEARCH_MATCH_LIMIT} matches exist; the rest are not kept. */
  capped: boolean;
  /** Why nothing was searched. */
  refusal?: 'empty' | 'too-long';
};

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/** Whether `index` falls between the two halves of a surrogate pair. */
function splitsPair(text: string, index: number): boolean {
  return (
    index > 0 &&
    index < text.length &&
    isHighSurrogate(text.charCodeAt(index - 1)) &&
    isLowSurrogate(text.charCodeAt(index))
  );
}

/** Whether `query` has more than {@link SEARCH_QUERY_CODE_POINT_LIMIT} code points. */
function exceedsQueryLimit(query: string): boolean {
  if (query.length > SEARCH_QUERY_CODE_POINT_LIMIT * 2) return true;
  let count = 0;
  for (let index = 0; index < query.length; index += 1) {
    if (isHighSurrogate(query.charCodeAt(index)) && isLowSurrogate(query.charCodeAt(index + 1))) {
      index += 1;
    }
    count += 1;
    if (count > SEARCH_QUERY_CODE_POINT_LIMIT) return true;
  }
  return false;
}

/**
 * Every non-overlapping, exact occurrence of `query` in `text`, in order. An occurrence that
 * starts or ends inside a surrogate pair is not a match: matching is by code point, not by code
 * unit, so half of an emoji never matches.
 */
export function findMatches(text: string, query: string): SearchResult {
  if (query === '') return { matches: [], capped: false, refusal: 'empty' };
  if (exceedsQueryLimit(query)) return { matches: [], capped: false, refusal: 'too-long' };
  const matches: Match[] = [];
  let from = 0;
  while (from <= text.length) {
    const start = text.indexOf(query, from);
    if (start < 0) break;
    const end = start + query.length;
    if (splitsPair(text, start) || splitsPair(text, end)) {
      from = start + 1;
      continue;
    }
    if (matches.length === SEARCH_MATCH_LIMIT) return { matches, capped: true };
    matches.push({ start, end });
    from = end;
  }
  return { matches, capped: false };
}

/** The code units before a match that must be unchanged for the match to count as the same one. */
export const MATCH_CONTEXT_CODE_UNITS = 32;
/** The code units shown either side of the active match. */
export const EXCERPT_CODE_UNITS = 80;

export type SearchStatus = 'idle' | 'too-long' | 'unavailable' | 'no-matches' | 'matches';

/** The active match with the text around it, for display only. Never leaves the component. */
export type Excerpt = { before: string; match: string; after: string };

export type SearchView = {
  status: SearchStatus;
  /** The number of matches kept. */
  count: number;
  /** The active match, counted from zero, or `undefined` when none is active. */
  index: number | undefined;
  capped: boolean;
  /** The searched text stops at its byte limit; matches beyond it are not found. */
  truncated: boolean;
  /** The last step went around the end. */
  wrapped: boolean;
  excerpt: Excerpt | undefined;
};

export type Search = {
  readonly view: SearchView;
  /** Replace the query and search `text` again; no match is active until the reader steps. */
  setQuery(query: string): void;
  /**
   * Search new text for the same query. The active match stays active only when the new text has
   * a match at the same logical position with the same text before it; otherwise nothing is.
   */
  update(text: string, truncated: boolean): void;
  /** Nothing can be searched: the output is gone, or belongs to another session. */
  makeUnavailable(): void;
  next(): void;
  previous(): void;
};

function excerptOf(text: string, match: Match): Excerpt {
  let start = Math.max(0, match.start - EXCERPT_CODE_UNITS);
  let end = Math.min(text.length, match.end + EXCERPT_CODE_UNITS);
  if (splitsPair(text, start)) start += 1;
  if (splitsPair(text, end)) end -= 1;
  return {
    before: text.slice(start, match.start),
    match: text.slice(match.start, match.end),
    after: text.slice(match.end, end),
  };
}

export function createSearch(): Search {
  let query = '';
  let text = '';
  let truncated = false;
  let unavailable = false;
  let result: SearchResult = { matches: [], capped: false, refusal: 'empty' };
  let current: number | undefined;
  let wrapped = false;

  function status(): SearchStatus {
    if (unavailable) return 'unavailable';
    if (result.refusal === 'empty') return 'idle';
    if (result.refusal === 'too-long') return 'too-long';
    return result.matches.length === 0 ? 'no-matches' : 'matches';
  }

  function contextOf(match: Match): string {
    return text.slice(Math.max(0, match.start - MATCH_CONTEXT_CODE_UNITS), match.end);
  }

  function search(): void {
    result = findMatches(text, query);
  }

  function step(direction: 1 | -1): void {
    const count = result.matches.length;
    if (unavailable || count === 0) return;
    if (current === undefined) {
      current = direction === 1 ? 0 : count - 1;
      wrapped = false;
      return;
    }
    const next = current + direction;
    wrapped = next < 0 || next >= count;
    current = (next + count) % count;
  }

  return {
    get view() {
      const match = current === undefined ? undefined : result.matches[current];
      return {
        status: status(),
        count: result.matches.length,
        index: current,
        capped: result.capped,
        truncated,
        wrapped,
        excerpt: match === undefined ? undefined : excerptOf(text, match),
      };
    },
    setQuery(next) {
      query = next;
      current = undefined;
      wrapped = false;
      search();
    },
    update(nextText, nextTruncated) {
      const previous = current === undefined ? undefined : result.matches[current];
      const previousContext = previous === undefined ? undefined : contextOf(previous);
      unavailable = false;
      text = nextText;
      truncated = nextTruncated;
      search();
      current = undefined;
      wrapped = false;
      if (previous === undefined) return;
      const survivor = result.matches.findIndex(
        (match) => match.start === previous.start && match.end === previous.end,
      );
      if (survivor >= 0 && contextOf(result.matches[survivor]!) === previousContext) {
        current = survivor;
      }
    },
    makeUnavailable() {
      unavailable = true;
      text = '';
      truncated = false;
      result = { matches: [], capped: false };
      current = undefined;
      wrapped = false;
    },
    next: () => step(1),
    previous: () => step(-1),
  };
}
