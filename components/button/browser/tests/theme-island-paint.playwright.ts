/// <reference lib="dom" />
/**
 * A theme island paints its own canvas and text. Redeclaring tokens under `[data-theme]` paints
 * nothing, so a dark island inside a light page used to keep the page's light background and
 * inherit its light text. The foundation styles now paint every non-root `[data-theme]` element at
 * zero specificity; `data-theme-paint="none"` leaves an island transparent.
 */

import { loadManifest } from '@lostgradient/testing';
import { expect, test } from '@playwright/test';

const manifest = loadManifest();
function fixtureRoute(slug: string): string {
  const entry = manifest.find((candidate) => candidate.slug === slug);
  const hash = entry?.fixtures?.find((fixture) => fixture.name === 'assertion')?.fixtureContentHash;
  if (hash === undefined) throw new Error(`Assertion fixture hash missing for ${slug}.`);
  return `/page/${slug}?snapshot=1&fixture=assertion&fixtureContentHash=${hash}`;
}

test('a dark island in a light page paints its own canvas and text', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  // The fixture shell applies its stored theme; make the page itself light.
  await page
    .context()
    .addInitScript(([key, value]) => localStorage.setItem(key, value), [
      'browser-fixture-theme',
      'light',
    ] as const);
  await page.goto(fixtureRoute('button'), { waitUntil: 'load' });
  await page.waitForSelector('.cinder-button', { state: 'attached' });

  const painted = await page.evaluate(() => {
    /** Appends a host with a probe child that resolves the island's own tokens. */
    const mount = (theme: string, paint?: string) => {
      const host = document.createElement('div');
      host.dataset['theme'] = theme;
      if (paint !== undefined) host.dataset['themePaint'] = paint;
      const probe = document.createElement('div');
      probe.style.backgroundColor = 'var(--cinder-surface-canvas)';
      probe.style.color = 'var(--cinder-text-default)';
      host.append(probe);
      document.body.append(host);
      const hostStyle = getComputedStyle(host);
      const probeStyle = getComputedStyle(probe);
      return {
        background: hostStyle.backgroundColor,
        color: hostStyle.color,
        canvas: probeStyle.backgroundColor,
        text: probeStyle.color,
      };
    };
    const body = getComputedStyle(document.body);
    return {
      page: { background: body.backgroundColor, color: body.color },
      dark: mount('dark'),
      light: mount('light'),
      optOut: mount('dark', 'none'),
    };
  });

  // The island paints exactly its own theme's canvas and default text.
  expect(painted.dark.background).toBe(painted.dark.canvas);
  expect(painted.dark.color).toBe(painted.dark.text);
  // ...which is not the light page's.
  expect(painted.dark.background).not.toBe(painted.page.background);
  expect(painted.dark.color).not.toBe(painted.page.color);
  // A light island inside the light page matches the page.
  expect(painted.light.background).toBe(painted.page.background);
  // The opt-out leaves the island transparent.
  expect(painted.optOut.background).toBe('rgba(0, 0, 0, 0)');
});
