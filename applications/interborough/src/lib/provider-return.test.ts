/**
 * The way back from Settings › Models (`provider-return.ts`): the address a page asks to return to
 * is read from the query string, so only the pages made to be returned to count.
 */
import { describe, expect, test } from 'bun:test';

import { connectProviderPath, returnPathOf } from './provider-return.ts';

const search = (value: string) => new URLSearchParams({ return: value });

describe('the address of Models that returns', () => {
  test('carries the path it returns to, encoded', () => {
    expect(connectProviderPath('/agents/new')).toBe('/settings/models?return=%2Fagents%2Fnew');
    expect(
      returnPathOf(new URLSearchParams(connectProviderPath('/agents/new').split('?')[1])),
    ).toBe('/agents/new');
  });
});

describe('the path to return to', () => {
  test('is the new agent form or an agent’s editor', () => {
    expect(returnPathOf(search('/agents/new'))).toBe('/agents/new');
    expect(returnPathOf(search('/agents/researcher/edit'))).toBe('/agents/researcher/edit');
  });

  test('is none when the address names none', () => {
    expect(returnPathOf(new URLSearchParams())).toBeNull();
  });

  test.each([
    ['another site', 'https://example.com/agents/new'],
    ['a protocol-relative address', '//example.com/agents/new'],
    ['a relative path', 'agents/new'],
    ['a page not made to be returned to', '/health'],
    ['a path with a query', '/agents/new?x=1'],
    ['a path with a fragment', '/agents/new#top'],
    ['a path with a backslash', '/agents\\new'],
    ['an unknown path', '/nowhere'],
  ])('is none for %s', (_name, value) => {
    expect(returnPathOf(search(value))).toBeNull();
  });
});
