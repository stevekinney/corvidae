import { describe, expect, test } from 'bun:test';

import { isInternalReference, normalizeSourcePath } from './resolver-order.ts';

describe('normalizeSourcePath', () => {
  test('collapses current-directory and parent segments the way a POSIX path does', () => {
    expect(normalizeSourcePath('./sets/x.tokens.json')).toBe('sets/x.tokens.json');
    expect(normalizeSourcePath('sets/../x.tokens.json')).toBe('x.tokens.json');
    expect(normalizeSourcePath('/sets/../../x.tokens.json')).toBe('/x.tokens.json');
  });

  test('keeps the parent segments of a relative path that climbs out of its root', () => {
    expect(normalizeSourcePath('../shared/x.tokens.json')).toBe('../shared/x.tokens.json');
    expect(normalizeSourcePath('sets/../../x.tokens.json')).toBe('../x.tokens.json');
  });

  test('decodes percent escapes and leaves a malformed escape for the existence check to report', () => {
    expect(normalizeSourcePath('sets/high%20contrast.tokens.json')).toBe(
      'sets/high contrast.tokens.json',
    );
    expect(normalizeSourcePath('sets/%E0%A4%A.tokens.json')).toBe('sets/%E0%A4%A.tokens.json');
  });
});

describe('isInternalReference', () => {
  test('recognizes a resolver-internal pointer, percent-encoded or not', () => {
    expect(isInternalReference('#/sets/base')).toBe(true);
    expect(isInternalReference('#%2Fsets%2Fbase')).toBe(true);
  });

  test('refuses a file path, a bare fragment and a malformed escape', () => {
    expect(isInternalReference('sets/base.tokens.json')).toBe(false);
    expect(isInternalReference('#sets')).toBe(false);
    expect(isInternalReference('#%E0%A4%A')).toBe(false);
  });
});
