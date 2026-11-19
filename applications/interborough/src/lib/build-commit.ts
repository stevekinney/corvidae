/**
 * The commit this build was made from, as the page shows it: a short SHA, with "(edited)" after it
 * when the tree had uncommitted changes. `scripts/build.ts` compiles it into the bundle by
 * replacing the expression below (`BUILD_COMMIT_VARIABLE` in `src/host/build-info.ts`), so a stale
 * build is visible at a glance. A source that was not built (a test, an editor) shows none.
 */
export function buildCommit(): string {
  return process.env.INTERBOROUGH_BUILD_COMMIT ?? '';
}
