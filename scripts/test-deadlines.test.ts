import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { bunTestArguments } from './bun-test.ts';
import { HANG_GUARD_MILLISECONDS } from './hang-guard.ts';
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

  test('is the value Weft’s coverage run computes for itself, since Weft cannot import root scripts', async () => {
    const source = await Bun.file(
      join(import.meta.dir, '..', 'packages', 'weft', 'scripts', 'check-coverage.ts'),
    ).text();
    expect(source).toContain(
      'const TEST_TIMEOUT_ARGUMENT = `--timeout=${2 * HANG_GUARD_MILLISECONDS}`;',
    );
  });
});
