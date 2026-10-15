import { describe, expect, test } from 'bun:test';

import { SEARCH_MATCH_LIMIT, SEARCH_QUERY_CODE_POINT_LIMIT } from './inspection-types.ts';
import {
  EXCERPT_CODE_UNITS,
  MATCH_CONTEXT_CODE_UNITS,
  createSearch,
  findMatches,
} from './search.ts';

const starts = (text: string, query: string) =>
  findMatches(text, query).matches.map((match) => match.start);

describe('findMatches', () => {
  test('matches case-sensitively', () => {
    expect(starts('Error error ERROR', 'error')).toEqual([6]);
    expect(starts('Error error ERROR', 'Error')).toEqual([0]);
  });

  test('applies no normalization: precomposed and decomposed forms differ in both directions', () => {
    const precomposed = 'café';
    const decomposed = 'café';
    expect(starts(precomposed, decomposed)).toEqual([]);
    expect(starts(decomposed, precomposed)).toEqual([]);
    expect(starts(decomposed, 'cafe')).toEqual([0]);
    expect(starts(precomposed, precomposed)).toEqual([0]);
  });

  test('treats regular-expression syntax as literal text', () => {
    expect(starts('a.b a+b (x) [y] ^$', '.')).toEqual([1]);
    expect(starts('a.b a+b (x) [y] ^$', 'a+b')).toEqual([4]);
    expect(starts('a.b a+b (x) [y] ^$', '(x)')).toEqual([8]);
    expect(starts('a.b a+b (x) [y] ^$', '[y]')).toEqual([12]);
    expect(starts('a.b a+b (x) [y] ^$', '^$')).toEqual([16]);
    expect(starts('abc', '.*')).toEqual([]);
  });

  test('allows a line feed in the query', () => {
    expect(starts('one\ntwo\nthree', 'one\ntwo')).toEqual([0]);
    expect(starts('one\ntwo', 'one two')).toEqual([]);
  });

  test('never matches half of a surrogate pair', () => {
    const text = 'a\u{1f600}b';
    expect(starts(text, '\ud83d')).toEqual([]);
    expect(starts(text, '\ude00')).toEqual([]);
    expect(starts(text, '\u{1f600}')).toEqual([1]);
    expect(starts('\ud83d😀', '\ud83d')).toEqual([0]);
  });

  test('does not overlap matches', () => {
    expect(starts('aaaa', 'aa')).toEqual([0, 2]);
  });

  test('an empty query searches nothing, and says why', () => {
    expect(findMatches('abc', '')).toEqual({ matches: [], capped: false, refusal: 'empty' });
  });

  test('refuses a query over the code point limit, counting a pair once', () => {
    const atLimit = '\u{1f600}'.repeat(SEARCH_QUERY_CODE_POINT_LIMIT);
    expect(findMatches(atLimit, atLimit).matches).toHaveLength(1);
    expect(findMatches(atLimit, `${atLimit}a`).refusal).toBe('too-long');
    expect(findMatches('a', 'a'.repeat(SEARCH_QUERY_CODE_POINT_LIMIT * 2 + 1)).refusal).toBe(
      'too-long',
    );
  });

  test('keeps at most the match limit and says it stopped', () => {
    const text = 'x'.repeat(SEARCH_MATCH_LIMIT + 5);
    const result = findMatches(text, 'x');
    expect(result.matches).toHaveLength(SEARCH_MATCH_LIMIT);
    expect(result.capped).toBe(true);
    const exact = findMatches('x'.repeat(SEARCH_MATCH_LIMIT), 'x');
    expect(exact.matches).toHaveLength(SEARCH_MATCH_LIMIT);
    expect(exact.capped).toBe(false);
  });
});

describe('createSearch', () => {
  function searching(text: string, query: string, truncated = false) {
    const search = createSearch();
    search.update(text, truncated);
    search.setQuery(query);
    return search;
  }

  test('starts idle', () => {
    expect(createSearch().view).toEqual({
      status: 'idle',
      count: 0,
      index: undefined,
      capped: false,
      truncated: false,
      wrapped: false,
      excerpt: undefined,
      match: undefined,
    });
  });

  test('reports no matches and a query that is too long', () => {
    expect(searching('abc', 'z').view.status).toBe('no-matches');
    expect(searching('abc', 'a'.repeat(SEARCH_QUERY_CODE_POINT_LIMIT + 1)).view.status).toBe(
      'too-long',
    );
  });

  test('next goes forward and wraps once past the last match, reporting index and count', () => {
    const search = searching('a b a b a', 'a');
    expect(search.view.count).toBe(3);
    expect(search.view.index).toBeUndefined();
    search.next();
    expect([search.view.index, search.view.wrapped]).toEqual([0, false]);
    search.next();
    search.next();
    expect([search.view.index, search.view.wrapped]).toEqual([2, false]);
    search.next();
    expect([search.view.index, search.view.wrapped]).toEqual([0, true]);
    search.next();
    expect([search.view.index, search.view.wrapped]).toEqual([1, false]);
  });

  test('previous starts at the last match and wraps once past the first', () => {
    const search = searching('a b a b a', 'a');
    search.previous();
    expect([search.view.index, search.view.wrapped]).toEqual([2, false]);
    search.previous();
    search.previous();
    expect(search.view.index).toBe(0);
    search.previous();
    expect([search.view.index, search.view.wrapped]).toEqual([2, true]);
  });

  test('stepping with no matches changes nothing', () => {
    const search = searching('abc', 'z');
    search.next();
    search.previous();
    expect(search.view.index).toBeUndefined();
  });

  test('names the active match by its offsets and text, for the terminal to select', () => {
    const search = searching('xx find yy find', 'find');
    search.next();
    expect(search.view.match).toEqual({ start: 3, end: 7, text: 'find' });
    search.next();
    expect(search.view.match).toEqual({ start: 11, end: 15, text: 'find' });
  });

  test('shows the active match with the text around it', () => {
    const search = searching(
      `${'x'.repeat(EXCERPT_CODE_UNITS + 10)}needle${'y'.repeat(200)}`,
      'needle',
    );
    search.next();
    expect(search.view.excerpt).toEqual({
      before: 'x'.repeat(EXCERPT_CODE_UNITS),
      match: 'needle',
      after: 'y'.repeat(EXCERPT_CODE_UNITS),
    });
  });

  test('never starts or ends an excerpt inside a surrogate pair', () => {
    const pair = '\u{1f600}';
    const search = searching(
      `${pair.repeat(EXCERPT_CODE_UNITS)}hit${pair.repeat(EXCERPT_CODE_UNITS)}`,
      'hit',
    );
    search.next();
    const { before, after } = search.view.excerpt!;
    expect(before).toBe(pair.repeat(EXCERPT_CODE_UNITS / 2));
    expect(after).toBe(pair.repeat(EXCERPT_CODE_UNITS / 2));
    const odd = searching(
      `a${pair.repeat(EXCERPT_CODE_UNITS)}hit${pair.repeat(EXCERPT_CODE_UNITS)}b`,
      'hit',
    );
    odd.next();
    expect(odd.view.excerpt!.before.startsWith(pair)).toBe(true);
    expect(odd.view.excerpt!.after.endsWith(pair)).toBe(true);
  });

  test('new output keeps the active match when it is at the same position with the same text before it', () => {
    const search = searching('one\ntwo\nfind me\n', 'find');
    search.next();
    expect(search.view.index).toBe(0);
    search.update('one\ntwo\nfind me\nmore output with find\n', false);
    expect(search.view.count).toBe(2);
    expect(search.view.index).toBe(0);
  });

  test('new output that adds an earlier match does not move the active match onto another', () => {
    const search = searching('x find', 'find');
    search.next();
    search.update('find x find', false);
    expect(search.view.count).toBe(2);
    expect(search.view.index).toBeUndefined();
  });

  test('eviction drops the match: it is not kept when the text before it changed', () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index} ${'-'.repeat(40)}`);
    const text = `${lines.join('\n')}\nfind`;
    const search = searching(text, 'find');
    search.next();
    expect(search.view.index).toBe(0);
    search.update(`${lines.slice(5).join('\n')}\nfind`, false);
    expect(search.view.count).toBe(1);
    expect(search.view.index).toBeUndefined();
  });

  test('a match whose output was evicted is unavailable', () => {
    const search = searching('evicted find', 'find');
    search.next();
    search.update('nothing here', false);
    expect(search.view.status).toBe('no-matches');
    expect(search.view.index).toBeUndefined();
  });

  test('only the text just before the match decides whether it is the same match', () => {
    expect(MATCH_CONTEXT_CODE_UNITS).toBeGreaterThan(0);
    const near = searching(`${'z'.repeat(80)}find`, 'find');
    near.next();
    near.update(`${'z'.repeat(40)}${'q'.repeat(40)}find`, false);
    expect(near.view.index).toBeUndefined();
    // Change beyond the window leaves the position and the nearby text alone, so it stays.
    const far = searching(`a${'z'.repeat(80)}find`, 'find');
    far.next();
    far.update(`b${'z'.repeat(80)}find`, false);
    expect(far.view.index).toBe(0);
  });

  test('changing the query clears the active match', () => {
    const search = searching('a b', 'a');
    search.next();
    search.setQuery('b');
    expect(search.view.index).toBeUndefined();
    expect(search.view.count).toBe(1);
  });

  test('reports a truncated search text and a capped match list', () => {
    const search = searching('x'.repeat(SEARCH_MATCH_LIMIT + 1), 'x', true);
    expect(search.view.truncated).toBe(true);
    expect(search.view.capped).toBe(true);
  });

  test('can be made unavailable, and a new update brings it back', () => {
    const search = searching('a a', 'a');
    search.next();
    search.makeUnavailable();
    expect(search.view.status).toBe('unavailable');
    expect(search.view.count).toBe(0);
    search.next();
    expect(search.view.index).toBeUndefined();
    search.update('a', false);
    expect(search.view.status).toBe('matches');
  });

  test('release forgets the text, the query and the matches', () => {
    const search = searching('find find', 'find');
    search.next();
    search.release();
    expect(search.view).toEqual({
      status: 'idle',
      count: 0,
      index: undefined,
      capped: false,
      truncated: false,
      wrapped: false,
      excerpt: undefined,
      match: undefined,
    });
    search.update('find', false);
    expect(search.view.status).toBe('idle');
  });
});
