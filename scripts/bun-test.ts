/**
 * Runs `bun test` with the repository's per-test deadline and the arguments given, holding one
 * slot of the host-wide test slot pool per worker (`scripts/bun-test-pool.ts`).
 *
 * Every blocking lane that does not write a JUnit report (`test:slow`, `test:coverage`, a focused
 * sub-lane) starts `bun test` through this wrapper, because the deadline has no other dependable
 * home (see `scripts/test-deadlines.ts`). `scripts/bun-test-junit.ts` does the same for the lanes
 * that do.
 *
 * Usage: `bun <path>/scripts/bun-test.ts <bun test arguments>`
 */

import { runPooledBunTest } from './bun-test-pool.ts';
import { TEST_TIMEOUT_ARGUMENT } from './test-deadlines.ts';

/** The argument list `bun test` receives: the deadline first, then the caller's own. */
export function bunTestArguments(argumentsList: readonly string[]): string[] {
  return ['test', TEST_TIMEOUT_ARGUMENT, ...argumentsList];
}

if (import.meta.main) {
  process.exitCode = await runPooledBunTest({ bunTestArguments: Bun.argv.slice(2) });
}
