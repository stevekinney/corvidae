import { describe, expect, test } from 'bun:test';

import { parseScopePrelude } from './text-direction-scope-parser.ts';

describe('parseScopePrelude', () => {
  test('reads the scope root and the limit that follows the to keyword', () => {
    expect(parseScopePrelude('@scope (.card) to (.content) {}')).toEqual({
      rootSelectors: ['.card'],
      limitSelectors: ['.content'],
    });
    expect(parseScopePrelude('@scope (.card)to(.content) {}')).toEqual({
      rootSelectors: ['.card'],
      limitSelectors: ['.content'],
    });
  });

  test('does not read the letters to inside another word as the limit keyword', () => {
    for (const word of ['auto', 'tom', 'to-do', 'mto']) {
      expect(parseScopePrelude(`@scope (.card) ${word} (.content) {}`)).toBeNull();
    }
  });

  test('refuses a to keyword that is not followed by a limit in parentheses', () => {
    expect(parseScopePrelude('@scope (.card) to {}')).toBeNull();
  });
});
