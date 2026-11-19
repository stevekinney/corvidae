import { afterEach, describe, expect, test } from 'bun:test';

import { buildCommit } from './build-commit.ts';

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'INTERBOROUGH_BUILD_COMMIT');
});

describe('buildCommit', () => {
  test('reads the text the build compiled in', () => {
    Reflect.set(globalThis, 'INTERBOROUGH_BUILD_COMMIT', 'abc1234');
    expect(buildCommit()).toBe('abc1234');
  });

  test('is empty for a source that was not built', () => {
    expect(buildCommit()).toBe('');
  });
});
