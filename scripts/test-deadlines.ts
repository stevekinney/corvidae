/**
 * The one deadline every blocking test shares.
 *
 * A test deadline that a loaded host can overrun is a flaky test: the work finishes, but later than
 * the clock allows, and the run fails for a reason no change caused. This workspace therefore has
 * a single deadline for tests in the gate, the awake-time hang guard (`HANG_GUARD_MILLISECONDS`),
 * and it is never a performance bound; a test that is merely slow, or a host that is merely busy,
 * must never fail it. `scripts/check-load-sensitive-deadlines.ts` rejects any shorter one.
 *
 * Bun offers one dependable way to raise the per-test deadline from its five-second default: the
 * `--timeout` flag. `[test] timeout` in `bunfig.toml` is not read by Bun 1.4, and
 * `setDefaultTimeout` in a preload applies to the first test file of a run and then resets. So
 * every `bun test` invocation in the repository passes the flag below, through `scripts/bun-test.ts`
 * and `scripts/bun-test-junit.ts` (or this module, for the scripts that start `bun test` themselves),
 * and the guard rejects an invocation that does not.
 *
 * The test timeout is twice the hang guard so that a wait the hang guard bounds, such as
 * Testing Library's `findBy*` (see `configureAsyncUtilityDeadline` in `@lostgradient/testing`),
 * fails with its own diagnostic before Bun stops the test.
 */

import { HANG_GUARD_MILLISECONDS } from './hang-guard.ts';

/** Bun's per-test timeout for every blocking lane. */
export const TEST_TIMEOUT_MILLISECONDS = 2 * HANG_GUARD_MILLISECONDS;

/** The `bun test` flag that carries {@link TEST_TIMEOUT_MILLISECONDS}. */
export const TEST_TIMEOUT_ARGUMENT = `--timeout=${TEST_TIMEOUT_MILLISECONDS}`;
