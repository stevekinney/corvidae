import { afterEach, describe, expect, test } from 'bun:test';

import { buildCommit } from './build-commit.ts';

const original = process.env.INTERBOROUGH_BUILD_COMMIT;
afterEach(() => {
  if (original === undefined) delete process.env.INTERBOROUGH_BUILD_COMMIT;
  else process.env.INTERBOROUGH_BUILD_COMMIT = original;
});

describe('buildCommit', () => {
  test('reads the text the build compiled in', () => {
    process.env.INTERBOROUGH_BUILD_COMMIT = 'abc1234';
    expect(buildCommit()).toBe('abc1234');
  });

  test('is empty for a source that was not built', () => {
    delete process.env.INTERBOROUGH_BUILD_COMMIT;
    expect(buildCommit()).toBe('');
  });
});
