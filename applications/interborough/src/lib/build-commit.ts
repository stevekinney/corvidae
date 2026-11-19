/**
 * The commit this build was made from, as the page shows it: a short SHA, with "(edited)" after it
 * when the tree had uncommitted changes. `scripts/build.ts` compiles it into the bundle by
 * replacing the identifier below (`BUILD_COMMIT_VARIABLE` in `src/host/build-info.ts`), so a stale
 * build is visible at a glance. A source that was not built (a test, an editor) shows none.
 */
declare const __INTERBOROUGH_BUILD_COMMIT__: string | undefined;

export function buildCommit(): string {
  return typeof __INTERBOROUGH_BUILD_COMMIT__ === 'string' ? __INTERBOROUGH_BUILD_COMMIT__ : '';
}
