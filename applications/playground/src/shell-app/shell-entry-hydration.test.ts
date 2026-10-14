import { describe, expect, test } from 'bun:test';

describe('landing shell hydration policy', () => {
  test('retries a failed hydration instead of memoizing the rejection', async () => {
    const source = await Bun.file(new URL('./shell-entry.ts', import.meta.url)).text();

    expect(source).toContain("import { memoizeUntilRejected } from './retryable-promise.ts'");
    expect(source).toContain('const hydrateShell = memoizeUntilRejected(hydrateShellOnce);');
    expect(source).not.toContain('shellHydration ??=');
  });

  test('applies no color override to the documentation page and has no deferred panel toggles', async () => {
    const source = await Bun.file(new URL('./shell-entry.ts', import.meta.url)).text();

    // The color panel is a link into the theme builder now, so the landing page has no panel to
    // hydrate and no override store to apply: documentation routes show shipped Cinder.
    expect(source).not.toContain('color-token-overrides');
    expect(source).not.toContain('ColorTokenOverrides');
    expect(source).not.toContain('attachDeferredToggle');
    expect(source).not.toContain('once: true');
  });

  test('subscribes to live reload before the deferred hydration and hands off to the hydrated page', async () => {
    const source = await Bun.file(new URL('./shell-entry.ts', import.meta.url)).text();

    // The landing page hydrates only on interaction, so until then nothing else on it would hear a
    // source edit. The hydrated page opens its own stream, so the bootstrap one closes with it.
    expect(source).toContain("import { attachLandingLiveReload } from './landing-live-reload.ts'");
    expect(source).toContain('const landingLiveReload = attachLandingLiveReload(document);');
    expect(source).toContain('landingLiveReload?.close();');
    expect(source.indexOf('landingLiveReload?.close();')).toBeGreaterThan(
      source.indexOf('svelte.hydrate('),
    );
  });

  test('follows an operating system theme change on the unhydrated landing page', async () => {
    const source = await Bun.file(new URL('./shell-entry.ts', import.meta.url)).text();

    // The toggle's label must follow a system theme switch the way a
    // click does, or the first click afterwards picks the theme from stale state.
    expect(source).toContain('followSystemTheme,');
    expect(source).toContain('followSystemTheme((systemTheme) => {');
    expect(source).toContain("themeToggle.setAttribute('aria-label', labelForTheme(systemTheme));");
  });
});
