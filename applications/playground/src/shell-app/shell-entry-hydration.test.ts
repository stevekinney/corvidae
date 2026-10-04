import { describe, expect, test } from 'bun:test';

describe('landing shell hydration policy', () => {
  test('retries a failed hydration instead of memoizing the rejection', async () => {
    const source = await Bun.file(new URL('./shell-entry.ts', import.meta.url)).text();

    // `bootstrapDeferredToggle` registers its click listener with `{ once: true }`, so a
    // memoized rejection would leave the toolbar controls inert until the page reloaded.
    expect(source).toContain("import { memoizeUntilRejected } from './retryable-promise.ts'");
    expect(source).toContain('const hydrateShell = memoizeUntilRejected(hydrateShellOnce);');
    expect(source).not.toContain('shellHydration ??=');
  });
});
