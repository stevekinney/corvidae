import { expect, test } from 'bun:test';
import { fixtureScopes } from './index.ts';

test('the synthetic role allowlist grants only each subject’s scopes', () => {
  expect(fixtureScopes('reader', 'reader', 'editor')).toEqual(['equipment:read']);
  expect(fixtureScopes('editor', 'reader', 'editor')).toEqual([
    'equipment:read',
    'equipment:write',
  ]);
  expect(fixtureScopes('other', 'reader', 'editor')).toBeNull();
  expect(() => fixtureScopes('same', 'same', 'same')).toThrow();
  expect(() => fixtureScopes('reader', 'reader', '')).toThrow();
});
