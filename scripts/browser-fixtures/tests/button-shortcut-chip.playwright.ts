/// <reference lib="dom" />
/**
 * A Button's shortcut keys read as keys: each is a chip with a wash of the button's text colour,
 * its glyphs in the button's own text colour, a clear gap after the label, and the button keeps
 * the height it has without a shortcut, on primary, secondary, ghost and danger at small to large,
 * in both themes, and disabled. Under forced colours each key keeps a 1px edge.
 */

import { loadManifest } from '@lostgradient/testing';
import { expect, type Locator } from '@playwright/test';
import { test } from './component-page-fixture.ts';
import { fixtureRoute } from './overlay-fixture.ts';

const entry = loadManifest().find((candidate) => candidate.slug === 'kbd');
const fixture = entry?.fixtures?.find((candidate) => candidate.name === 'button-shortcut');
const rows = ['primary', 'secondary', 'ghost', 'danger'].flatMap((variant) =>
  ['sm', 'md', 'lg'].map((size) => `${variant}-${size}`),
);

async function measure(row: Locator) {
  const [withShortcut, without] = [row.locator('button').nth(0), row.locator('button').nth(1)];
  const key = withShortcut.locator('.cinder-kbd').first();
  const style = await key.evaluate((element) => {
    const computed = getComputedStyle(element);
    const button = element.closest('button');
    const label = button?.querySelector('.cinder-button__label');
    return {
      background: computed.backgroundColor,
      color: computed.color,
      buttonColor: button ? getComputedStyle(button).color : '',
      borderWidth: computed.borderTopWidth,
      opacity: computed.opacity,
      gap:
        element.getBoundingClientRect().left - (label?.getBoundingClientRect().right ?? Number.NaN),
    };
  });
  const [withBox, withoutBox, keyBox] = await Promise.all([
    withShortcut.boundingBox(),
    without.boundingBox(),
    key.boundingBox(),
  ]);
  return {
    ...style,
    withHeight: withBox?.height ?? 0,
    withoutHeight: withoutBox?.height ?? 0,
    keyHeight: keyBox?.height ?? 0,
  };
}

for (const theme of ['light', 'dark'] as const) {
  test(`shortcut keys are quiet chips that never grow the button (${theme})`, async ({
    componentPage,
  }) => {
    if (entry === undefined || fixture === undefined)
      throw new Error('No button shortcut fixture.');
    const page = await componentPage.open({
      entry,
      theme,
      viewport: { name: 'desktop', width: 1280, height: 900 },
      fixtureName: 'button-shortcut',
      fixtureContentHash: fixture.fixtureContentHash,
    });
    for (const id of [...rows, 'disabled-md']) {
      const result = await measure(page.getByTestId(id));
      expect(result.withHeight, `${id} height`).toBeCloseTo(result.withoutHeight, 1);
      expect(result.keyHeight, `${id} key height`).toBeLessThan(result.withHeight);
      expect(result.background, `${id} chip fill`).not.toBe('rgba(0, 0, 0, 0)');
      expect(result.color, `${id} glyph colour`).toBe(result.buttonColor);
      expect(result.opacity, `${id} glyph opacity`).toBe('1');
      expect(result.borderWidth, `${id} border`).toBe('0px');
      // The button's own gap (6px) and the chip's step after it (4px).
      expect(result.gap, `${id} gap`).toBeGreaterThanOrEqual(9.5);
    }
  });
}

test('under forced colours each key keeps a 1px edge', async ({ browser }) => {
  const context = await browser.newContext({
    forcedColors: 'active',
    viewport: { width: 1280, height: 900 },
  });
  try {
    const page = await context.newPage();
    await page.goto(fixtureRoute('kbd', { fixtureName: 'button-shortcut' }), { waitUntil: 'load' });
    await page.getByTestId('primary-md').locator('.cinder-kbd').first().waitFor();
    expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
    const result = await measure(page.getByTestId('primary-md'));
    expect(result.borderWidth).toBe('1px');
    expect(result.withHeight).toBeCloseTo(result.withoutHeight, 1);
  } finally {
    await context.close();
  }
});
