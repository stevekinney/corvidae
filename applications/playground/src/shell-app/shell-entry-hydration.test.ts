import { describe, expect, test } from 'bun:test';

describe('landing shell hydration policy', () => {
  test('retries a failed hydration instead of memoizing the rejection', async () => {
    const source = await Bun.file(new URL('./shell-entry.ts', import.meta.url)).text();

    expect(source).toContain("import { memoizeUntilRejected } from './retryable-promise.ts'");
    expect(source).toContain('const hydrateShell = memoizeUntilRejected(hydrateShellOnce);');
    expect(source).not.toContain('shellHydration ??=');
  });

  test('wires every deferred toolbar button through the retryable bootstrap', async () => {
    const source = await Bun.file(new URL('./shell-entry.ts', import.meta.url)).text();

    // The bootstrap's own behavior, including a retry after a failed attempt, is
    // covered by deferred-toggle.test.ts; this pins that the entry uses it rather
    // than registering a listener that removes itself.
    expect(source).toContain("import { attachDeferredToggle } from './deferred-toggle.ts'");
    expect(source).not.toContain('once: true');
  });
});
