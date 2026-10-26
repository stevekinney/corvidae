/**
 * Runs `bun test` with the repository's per-test deadline and the arguments given.
 *
 * Every blocking lane that does not write a JUnit report (`test:slow`, `test:coverage`, a focused
 * sub-lane) starts `bun test` through this wrapper, because the deadline has no other dependable
 * home (see `scripts/test-deadlines.ts`). `scripts/bun-test-junit.ts` does the same for the lanes
 * that do.
 *
 * Usage: `bun <path>/scripts/bun-test.ts <bun test arguments>`
 */

import { TEST_TIMEOUT_ARGUMENT } from './test-deadlines.ts';

/** The argument list `bun test` receives: the deadline first, then the caller's own. */
export function bunTestArguments(argumentsList: readonly string[]): string[] {
  return ['test', TEST_TIMEOUT_ARGUMENT, ...argumentsList];
}

if (import.meta.main) {
  const child = Bun.spawn(['bun', ...bunTestArguments(Bun.argv.slice(2))], {
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  });
  process.exitCode = await child.exited;
}
