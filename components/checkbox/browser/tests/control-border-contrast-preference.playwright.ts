/// <reference lib="dom" />
/**
 * A control's edge is the quiet `border.control` tier at rest and the 3:1 `border.contrast` tier
 * when the person asks for more contrast (owner decision, 2026-11-11). The switch is one
 * `@media (prefers-contrast: more)` block of aliases that follows the theme blocks in
 * `tokens-base.css`, so only the rendered cascade can prove it wins: at the root, and inside a
 * `[data-theme]` island of the other scheme, whose own block redeclares the control tiers.
 */

import { loadManifest } from '@lostgradient/testing';
import { expect, test, type Page } from '@playwright/test';

const manifest = loadManifest();
function fixtureRoute(slug: string): string {
  const entry = manifest.find((candidate) => candidate.slug === slug);
  const hash = entry?.fixtures?.find((fixture) => fixture.name === 'assertion')?.fixtureContentHash;
  if (hash === undefined) throw new Error(`Assertion fixture hash missing for ${slug}.`);
  return `/page/${slug}?snapshot=1&fixture=assertion&fixtureContentHash=${hash}`;
}

/** The colors a field's edge, and each tier on its own, compute to at the root and in a dark island. */
async function edges(page: Page) {
  return page.evaluate(() => {
    const read = (theme: string | undefined) => {
      const host = document.createElement('div');
      if (theme !== undefined) host.dataset['theme'] = theme;
      document.body.append(host);
      const colorOf = (value: string): string => {
        const probe = document.createElement('span');
        probe.style.border = `1px solid ${value}`;
        host.append(probe);
        return getComputedStyle(probe).borderTopColor;
      };
      const result = {
        field: colorOf('var(--cinder-control-border)'),
        fieldHover: colorOf('var(--cinder-control-border-hover)'),
        button: colorOf('var(--cinder-button-border)'),
        control: colorOf('var(--cinder-border-control)'),
        contrast: colorOf('var(--cinder-border-contrast)'),
        contrastHover: colorOf('var(--cinder-border-contrast-hover)'),
      };
      host.remove();
      return result;
    };
    return { root: read(undefined), island: read('dark') };
  });
}

test('more contrast turns every control edge into the contrast tier, in a themed island too', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light', contrast: 'no-preference' });
  await page.goto(fixtureRoute('checkbox'), { waitUntil: 'load' });
  await page.waitForSelector('.cinder-checkbox', { state: 'attached' });

  const resting = await edges(page);
  for (const scope of [resting.root, resting.island]) {
    expect(scope.field).toBe(scope.control);
    expect(scope.button).toBe(scope.control);
    expect(scope.field).not.toBe(scope.contrast);
  }
  // The island is dark on a light page, so its tiers are its own.
  expect(resting.island.contrast).not.toBe(resting.root.contrast);

  await page.emulateMedia({ colorScheme: 'light', contrast: 'more' });
  const heightened = await edges(page);
  for (const [scope, before] of [
    [heightened.root, resting.root],
    [heightened.island, resting.island],
  ] as const) {
    expect(scope.contrast).toBe(before.contrast);
    expect(scope.field).toBe(scope.contrast);
    expect(scope.button).toBe(scope.contrast);
    expect(scope.control).toBe(scope.contrast);
    expect(scope.fieldHover).toBe(scope.contrastHover);
  }
});
