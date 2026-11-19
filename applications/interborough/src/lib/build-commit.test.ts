import { afterEach, describe, expect, test } from 'bun:test';

import { buildCommit } from './build-commit.ts';

afterEach(() => {
  Reflect.deleteProperty(globalThis, '__INTERBOROUGH_BUILD_COMMIT__');
});

describe('buildCommit', () => {
  test('reads the text the build compiled in', () => {
    Reflect.set(globalThis, '__INTERBOROUGH_BUILD_COMMIT__', 'abc1234');
    expect(buildCommit()).toBe('abc1234');
  });

  test('is empty for a source that was not built', () => {
    expect(buildCommit()).toBe('');
  });
});
