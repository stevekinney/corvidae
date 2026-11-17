import { describe, expect, test } from 'bun:test';

import { parseCommandQuery } from './command-query.ts';

const scopes = [
  { prefix: '>', scope: 'actions' },
  { prefix: '@', scope: 'agents' },
] as const;

describe('parseCommandQuery', () => {
  test('reads a > prefix as actions and drops it', () => {
    expect(parseCommandQuery('> restart', scopes)).toEqual({ scope: 'actions', term: 'restart' });
    expect(parseCommandQuery('>restart', scopes)).toEqual({ scope: 'actions', term: 'restart' });
  });

  test('reads an @ prefix as agents', () => {
    expect(parseCommandQuery('@tool', scopes)).toEqual({ scope: 'agents', term: 'tool' });
  });

  test('a bare prefix narrows to the scope with an empty term', () => {
    expect(parseCommandQuery('>', scopes)).toEqual({ scope: 'actions', term: '' });
    expect(parseCommandQuery('  @ ', scopes)).toEqual({ scope: 'agents', term: '' });
  });

  test('a query with no prefix is returned whole, scope undefined', () => {
    expect(parseCommandQuery('home', scopes)).toEqual({ scope: undefined, term: 'home' });
    expect(parseCommandQuery('', scopes)).toEqual({ scope: undefined, term: '' });
  });

  test('only a leading prefix counts', () => {
    expect(parseCommandQuery('go > home', scopes)).toEqual({ scope: undefined, term: 'go > home' });
  });

  test('the longest matching prefix wins', () => {
    const nested = [
      { prefix: '>', scope: 'actions' },
      { prefix: '>>', scope: 'dangerous-actions' },
    ] as const;
    expect(parseCommandQuery('>> wipe', nested)).toEqual({
      scope: 'dangerous-actions',
      term: 'wipe',
    });
  });

  test('ignores an empty prefix and an empty scope list', () => {
    expect(parseCommandQuery('x', [{ prefix: '', scope: 'all' }])).toEqual({
      scope: undefined,
      term: 'x',
    });
    expect(parseCommandQuery('> x', [])).toEqual({ scope: undefined, term: '> x' });
  });
});
