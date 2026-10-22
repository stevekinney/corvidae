/// <reference lib="dom" />
/**
 * COR-1552: the Toggle's visible track is 32×18 with a 14px thumb, and its hit area is not.
 *
 * happy-dom performs no layout, and the playground reference scene renders no Toggle, so the
 * WCAG 2.5.8 target-size check never measures one. The sizes that depend on real geometry are
 * asserted here: the painted track, read from a screenshot so the assertion holds whatever
 * mechanism draws it inside the hit area; the 24px floor of the button's own box with a fine
 * pointer; and the 44×44 box under a coarse pointer, which Chromium resolves from the context's
 * `hasTouch` and `isMobile` rather than from `page.emulateMedia`.
 */

import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { fixtureRoute } from './overlay-fixture.ts';

const TOGGLE = 'button.cinder-toggle';
const TRACK = { width: 32, height: 18 };
const THUMB = 14;
const TRAVEL = 14;
// A painted pixel differs from the page background by more than this in some channel.
const PAINT_THRESHOLD = 40;
// Edge pixels of the rounded track are antialiased, so the painted box is read to the pixel.
const PAINT_TOLERANCE = 1.5;

async function paintedTrack(
  page: Page,
  button: Locator,
): Promise<{ width: number; height: number }> {
  const box = await button.boundingBox();
  if (box === null) throw new Error('The Toggle has no layout box.');
  const margin = 6;
  const png = PNG.sync.read(
    await page.screenshot({
      animations: 'disabled',
      clip: {
        x: box.x - margin,
        y: box.y - margin,
        width: box.width + margin * 2,
        height: box.height + margin * 2,
      },
    }),
  );
  const channel = (x: number, y: number, offset: number): number =>
    png.data[(y * png.width + x) * 4 + offset]!;
  let left = png.width;
  let right = -1;
  let top = png.height;
  let bottom = -1;
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const differs = [0, 1, 2].some(
        (offset) => Math.abs(channel(x, y, offset) - channel(0, 0, offset)) > PAINT_THRESHOLD,
      );
      if (!differs) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < 0) throw new Error('The Toggle painted nothing inside its box.');
  return { width: right - left + 1, height: bottom - top + 1 };
}

async function openToggle(page: Page, fixtureName: 'assertion' | 'on'): Promise<Locator> {
  await page.goto(fixtureRoute('toggle', { fixtureName }), { waitUntil: 'load' });
  const button = page.locator(TOGGLE).first();
  await button.waitFor({ state: 'visible' });
  // The fixture page has text and a button around the Toggle, within a few pixels of its box. They
  // keep their layout but stop painting, so the painted region read below is the track alone.
  await page.addStyleTag({
    content:
      'p, button:not(.cinder-toggle), .cinder-toggle-field__label { visibility: hidden !important; }',
  });
  await page.evaluate(
    'document.activeElement instanceof HTMLElement && document.activeElement.blur()',
  );
  return button;
}

async function coarsePage(browser: Browser): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 1,
    viewport: { width: 390, height: 844 },
  });
  return { page: await context.newPage(), close: () => context.close() };
}

function expectTrack(painted: { width: number; height: number }): void {
  expect(Math.abs(painted.width - TRACK.width)).toBeLessThanOrEqual(PAINT_TOLERANCE);
  expect(Math.abs(painted.height - TRACK.height)).toBeLessThanOrEqual(PAINT_TOLERANCE);
}

test.describe('Toggle size', () => {
  test('the visible track is 32×18 when off', async ({ page }) => {
    const button = await openToggle(page, 'assertion');
    await expect(button).toHaveAttribute('aria-checked', 'false');
    expectTrack(await paintedTrack(page, button));
  });

  test('the visible track is 32×18 when on', async ({ page }) => {
    const button = await openToggle(page, 'on');
    await expect(button).toHaveAttribute('aria-checked', 'true');
    expectTrack(await paintedTrack(page, button));
  });

  test('the visible track is 32×18 while hovered, off and on', async ({ page }) => {
    for (const fixtureName of ['assertion', 'on'] as const) {
      const button = await openToggle(page, fixtureName);
      await button.hover();
      expectTrack(await paintedTrack(page, button));
    }
  });

  test('the thumb is 14px and travels 14px', async ({ page }) => {
    const off = await openToggle(page, 'assertion');
    const thumbOff = await off.locator('.cinder-toggle__thumb').boundingBox();
    const on = await openToggle(page, 'on');
    const thumbOn = await on.locator('.cinder-toggle__thumb').boundingBox();
    const offBox = await off.boundingBox();
    const onBox = await on.boundingBox();
    expect(thumbOff?.width).toBeCloseTo(THUMB, 0);
    expect(thumbOff?.height).toBeCloseTo(THUMB, 0);
    // Both boxes start at the same x, so the thumb's offset inside its own button is the travel.
    expect(thumbOn!.x - onBox!.x - (thumbOff!.x - offBox!.x)).toBeCloseTo(TRAVEL, 0);
  });

  test('fine pointer: the button box is at least 24px tall', async ({ page }) => {
    // WCAG 2.5.8 measures the element's own box, which a pseudo-element would not enlarge.
    await page.emulateMedia({ media: 'screen' });
    const button = await openToggle(page, 'assertion');
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(false);
    const box = await button.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(24);
    expect(box!.width).toBeGreaterThanOrEqual(24);
  });

  test('coarse pointer: the button box is at least 44×44 and the track stays 32×18', async ({
    browser,
  }) => {
    const { page, close } = await coarsePage(browser);
    try {
      for (const fixtureName of ['assertion', 'on'] as const) {
        const button = await openToggle(page, fixtureName);
        expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
        const box = await button.boundingBox();
        expect(box!.width).toBeGreaterThanOrEqual(44);
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expectTrack(await paintedTrack(page, button));
      }
    } finally {
      await close();
    }
  });
});
