/// <reference lib="dom" />
/**
 * The feature Banner's layout holds at 360, 768 and 1280 pixels (COR-2363 AC4, COR-2441): the glyph
 * art is a 48px disc at the start of the row, the words never run under the art or off the banner,
 * the dismiss button sits at the inline end, and the actions trail the words on the same row when
 * the banner is at least 560px wide and drop under them, starting where the words start, below
 * that. Measured in a browser on the `feature` fixture, in both themes.
 */

import { loadManifest } from '@lostgradient/testing';
import { expect, type Locator } from '@playwright/test';
import { test } from './component-page-fixture.ts';
import { ALIGNMENT_TOLERANCE, boxOf } from './first-line-alignment.ts';

const entry = loadManifest().find((candidate) => candidate.slug === 'banner');
const fixture = entry?.fixtures?.find((candidate) => candidate.name === 'feature');

/** The banner's own width where the actions move under the words: `34.99rem` at 16px. */
const NARROW_BELOW = 560;

const VIEWPORTS = [
  { name: 'phone', width: 360, height: 780, trailing: false },
  { name: 'tablet', width: 768, height: 1024, trailing: true },
  { name: 'desktop', width: 1280, height: 900, trailing: true },
] as const;

async function expectLayout(host: Locator, trailing: boolean): Promise<void> {
  const banner = host.locator('.cinder-banner');
  await banner.locator('.cinder-banner__actions button').first().waitFor({ state: 'visible' });
  const box = await boxOf(banner);
  const width = box.right - box.left;
  // The viewport is what the banner's own width follows here, so the fixture is on the side of the
  // threshold the case names.
  if (trailing) expect(width).toBeGreaterThanOrEqual(NARROW_BELOW);
  else expect(width).toBeLessThan(NARROW_BELOW);

  const art = await boxOf(banner.locator('.cinder-banner__art'));
  const content = await boxOf(banner.locator('.cinder-banner__content'));
  const actions = await boxOf(banner.locator('.cinder-banner__actions'));
  const dismiss = banner.locator('.cinder-banner__dismiss');

  // The art is a 48px disc at the start, inside the banner.
  expect(Math.abs(art.right - art.left - 48)).toBeLessThanOrEqual(ALIGNMENT_TOLERANCE);
  expect(art.left).toBeGreaterThanOrEqual(box.left);
  // The words start after the art and stay inside the banner.
  expect(content.left).toBeGreaterThanOrEqual(art.right);
  expect(content.right).toBeLessThanOrEqual(box.right);
  expect(actions.right).toBeLessThanOrEqual(box.right + ALIGNMENT_TOLERANCE);

  if (trailing) {
    expect(actions.left).toBeGreaterThanOrEqual(content.right);
    expect(actions.top).toBeLessThan(content.bottom);
  } else {
    expect(actions.top).toBeGreaterThanOrEqual(content.bottom);
    expect(Math.abs(actions.left - content.left)).toBeLessThanOrEqual(ALIGNMENT_TOLERANCE);
  }

  if ((await dismiss.count()) > 0) {
    const dismissBox = await boxOf(dismiss);
    expect(dismissBox.right).toBeLessThanOrEqual(box.right);
    expect(dismissBox.left).toBeGreaterThanOrEqual(content.right - ALIGNMENT_TOLERANCE);
    if (trailing) expect(actions.right).toBeLessThanOrEqual(dismissBox.left + ALIGNMENT_TOLERANCE);
  }

  // Nothing makes the banner scroll sideways.
  const overflow = await banner.evaluate((root) => root.scrollWidth - root.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

for (const theme of ['light', 'dark'] as const) {
  for (const viewport of VIEWPORTS) {
    test(`the feature banner lays out at ${viewport.width}px (${theme}, ${viewport.name})`, async ({
      componentPage,
    }) => {
      if (entry === undefined || fixture === undefined)
        throw new Error('No banner feature fixture.');
      const page = await componentPage.open({
        entry,
        theme,
        viewport: { name: viewport.name, width: viewport.width, height: viewport.height },
        fixtureName: 'feature',
        fixtureContentHash: fixture.fixtureContentHash,
      });
      await expectLayout(page.getByTestId('feature'), viewport.trailing);
      await expectLayout(page.getByTestId('feature-short'), viewport.trailing);
    });
  }
}
