/** Tests for the scope catalog: one entry for every authorization scope, found by scope. */
import { describe, expect, test } from 'bun:test';

import { AUTHORIZATION_SCOPES } from '../../lib/scopes.svelte.ts';
import { SCOPE_CATALOG, scopeCatalogEntry } from './scope-catalog.ts';

describe('the scope catalog', () => {
  test('has one described entry for every authorization scope, in declaration order', () => {
    expect(SCOPE_CATALOG.map((entry) => entry.scope)).toEqual([...AUTHORIZATION_SCOPES]);
    for (const entry of SCOPE_CATALOG) {
      expect(entry.description).not.toBe('');
      expect(entry.unlocks).not.toBe('');
    }
  });

  test('finds the entry for a scope', () => {
    for (const scope of AUTHORIZATION_SCOPES) {
      expect(scopeCatalogEntry(scope).scope).toBe(scope);
      expect(scopeCatalogEntry(scope)).toBe(SCOPE_CATALOG.find((entry) => entry.scope === scope)!);
    }
  });
});
