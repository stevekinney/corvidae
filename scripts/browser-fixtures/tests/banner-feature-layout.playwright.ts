/// <reference lib="dom" />
/**
 * The feature Banner's layout holds at 320, 360, 768 and 1280 pixels (COR-2363 AC4, COR-2441).
 * Wide (the banner is at least 560px across): the glyph art is a 48px disc at the start of the row,
 * the words start after it and stay inside the banner, the actions trail the words on the same row
 * and the dismiss button sits at the inline end. Narrow (below 560px): the art is a 32px disc on the
 * title's line, the words and the actions start at the banner's leading padding (the art's left
 * edge) instead of a hundred pixels in, the actions stay inside the banner (two buttons fit at
 * 320), and the dismiss button centres on the title's line. Measured in a browser on the `feature`
 * fixture, in both themes. Each case sets its own viewport.
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
  { name: 'phone-small', width: 320, height: 640, trailing: false },
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
  const title = await boxOf(banner.locator('.cinder-banner__title'));
  const content = await boxOf(banner.locator('.cinder-banner__content'));
  const actions = await boxOf(banner.locator('.cinder-banner__actions'));
  const dismiss = banner.locator('.cinder-banner__dismiss');

  expect(art.left).toBeGreaterThanOrEqual(box.left);
  expect(content.right).toBeLessThanOrEqual(box.right);
  expect(actions.right).toBeLessThanOrEqual(box.right + ALIGNMENT_TOLERANCE);

  if (trailing) {
    // A 48px disc at the start; the words start after it.
    expect(Math.abs(art.right - art.left - 48)).toBeLessThanOrEqual(ALIGNMENT_TOLERANCE);
    expect(content.left).toBeGreaterThanOrEqual(art.right);
    expect(actions.left).toBeGreaterThanOrEqual(content.right);
    expect(actions.top).toBeLessThan(content.bottom);
  } else {
    // A 32px disc on the title's line, and the words and the actions share the art's left edge.
    expect(Math.abs(art.right - art.left - 32)).toBeLessThanOrEqual(ALIGNMENT_TOLERANCE);
    expect(Math.abs(art.center - title.center)).toBeLessThanOrEqual(ALIGNMENT_TOLERANCE * 2);
    expect(Math.abs(content.left - art.left)).toBeLessThanOrEqual(ALIGNMENT_TOLERANCE);
    expect(Math.abs(actions.left - art.left)).toBeLessThanOrEqual(ALIGNMENT_TOLERANCE);
    expect(actions.top).toBeGreaterThanOrEqual(content.bottom);
    // Every action is whole inside the banner: two buttons do not wrap out of it at 320.
    const buttons = banner.locator('.cinder-banner__actions button');
    for (let index = 0; index < (await buttons.count()); index += 1) {
      const button = await boxOf(buttons.nth(index));
      expect(button.right).toBeLessThanOrEqual(box.right);
      expect(button.left).toBeGreaterThanOrEqual(box.left);
    }
  }

  if ((await dismiss.count()) > 0) {
    const dismissBox = await boxOf(dismiss);
    expect(dismissBox.right).toBeLessThanOrEqual(box.right);
    if (trailing) {
      expect(dismissBox.left).toBeGreaterThanOrEqual(content.right - ALIGNMENT_TOLERANCE);
      expect(actions.right).toBeLessThanOrEqual(dismissBox.left + ALIGNMENT_TOLERANCE);
    } else {
      // The dismiss button centres on the title's line, not on the body.
      expect(Math.abs(dismissBox.center - title.center)).toBeLessThanOrEqual(
        ALIGNMENT_TOLERANCE * 2,
      );
    }
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
