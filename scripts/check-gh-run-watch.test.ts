import { describe, expect, test } from 'bun:test';

import { watchUses } from './check-gh-run-watch';

describe('gh run watch ban', () => {
  test('flags a use of the command', () => {
    const source = ['wait with:', 'gh run watch 123 --exit-status', '  gh  run  watch 9'].join(
      '\n',
    );
    expect(watchUses(source)).toEqual([2, 3]);
  });

  test('allows a sentence that says not to use it', () => {
    expect(watchUses('Never `gh run watch`; wait with wait-run.ts.')).toEqual([]);
    expect(watchUses('Do not use gh run watch here.')).toEqual([]);
  });

  test('ignores text that only resembles it', () => {
    expect(watchUses('gh run view 1 and gh workflow run watch-me')).toEqual([]);
  });
});
