import { describe, expect, test } from 'bun:test';
import { HANG_GUARD_MILLISECONDS } from '../testing/testing/src/hang-guard.ts';
import { bunTestArguments } from './bun-test.ts';
import { TEST_TIMEOUT_ARGUMENT, TEST_TIMEOUT_MILLISECONDS } from './test-deadlines.ts';

describe('the shared test deadline', () => {
  test('is twice the hang guard, so a wait the hang guard bounds fails with its own message first', () => {
    expect(TEST_TIMEOUT_MILLISECONDS).toBe(2 * HANG_GUARD_MILLISECONDS);
    expect(TEST_TIMEOUT_ARGUMENT).toBe(`--timeout=${2 * HANG_GUARD_MILLISECONDS}`);
  });

  test('is passed to bun test ahead of the caller’s own arguments by the wrapper', () => {
    expect(bunTestArguments(['--parallel=4', 'src'])).toEqual([
      'test',
      TEST_TIMEOUT_ARGUMENT,
      '--parallel=4',
      'src',
    ]);
  });
});
