/// <reference lib="dom" />
/**
 * A suggested Chip is the same height as a plain one, and its label sits on the same baseline
 * (COR-2441): the sparkle glyph that tells a sighted person apart from colour alone must not
 * lengthen the chip's line. Measured in a browser on the `suggested` fixture, in both themes, for
 * the display chip and the toggle chip. Heights, baselines and positions hold within 0.5px.
 *
 * A pass on a developer machine is not enough: the glyph once grew the chip by 0.6px only on
 * Linux's font (the fixtures' renderer), where the line's ascent and descent differ from macOS's,
 * so this has to pass in CI.
 */

import { loadManifest } from '@lostgradient/testing';
import { test as componentTest } from '@lostgradient/testing/playwright/component-page-fixture';
import { test as browserTest, expect, type Browser } from '@playwright/test';

const entry = loadManifest().find((candidate) => candidate.slug === 'chip');
const fixture = entry?.fixtures?.find((candidate) => candidate.name === 'suggested');

for (const theme of ['light', 'dark'] as const) {
  componentTest(
    `a suggested chip matches a plain chip's height and baseline (${theme})`,
    async ({ componentPage }) => {
      if (entry === undefined || fixture === undefined)
        throw new Error('No chip suggested fixture.');
      const page = await componentPage.open({
        entry,
        theme,
        viewport: { name: 'desktop', width: 1280, height: 900 },
        fixtureName: 'suggested',
        fixtureContentHash: fixture.fixtureContentHash,
      });
      for (const [suggestedId, plainId] of [
        ['suggested', 'plain'],
        ['suggested-toggle', 'plain-toggle'],
      ] as const) {
        const measure = async (id: string) =>
          page
            .getByTestId(id)
            .locator('.cinder-chip')
            .evaluate((chip) => {
              const label = chip.querySelector('.cinder-chip__label');
              if (!(label instanceof HTMLElement)) throw new Error('No label.');
              // A zero-height inline box on the label's first line sits on its baseline.
              const probe = document.createElement('span');
              probe.style.cssText = 'display:inline-block;inline-size:0;block-size:0';
              label.append(probe);
              const baseline =
                probe.getBoundingClientRect().bottom - chip.getBoundingClientRect().top;
              probe.remove();
              // The chip's own baseline as an inline box: a zero-height probe on a line's baseline
              // beside a copy of the chip. The chip's baseline comes from its first flex item, so a
              // glyph ahead of the label would move a chip off the line it sits on.
              const line = document.createElement('div');
              const lineProbe = document.createElement('span');
              lineProbe.style.cssText = 'display:inline-block;inline-size:0;block-size:0';
              const copy = chip.cloneNode(true) as HTMLElement;
              line.append(lineProbe, copy);
              document.body.append(line);
              const onLine =
                copy.getBoundingClientRect().top - lineProbe.getBoundingClientRect().bottom;
              line.remove();
              return { height: chip.getBoundingClientRect().height, baseline, onLine };
            });
        const suggested = await measure(suggestedId);
        const plain = await measure(plainId);
        const within = (a: number, b: number) => Math.abs(a - b);
        expect(within(suggested.height, plain.height), `${suggestedId} height`).toBeLessThanOrEqual(
          0.5,
        );
        expect(
          within(suggested.baseline, plain.baseline),
          `${suggestedId} baseline`,
        ).toBeLessThanOrEqual(0.5);
        expect(
          within(suggested.onLine, plain.onLine),
          `${suggestedId} position on a line`,
        ).toBeLessThanOrEqual(0.5);
      }
    },
  );
}

async function coarsePage(
  browser: Browser,
): Promise<{ page: import('@playwright/test').Page; close: () => Promise<void> }> {
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 1,
    viewport: { width: 320, height: 640 },
  });
  return { page: await context.newPage(), close: () => context.close() };
}

browserTest(
  'a coarse toggle chip keeps a compact face while both 44px targets and its neighbour work',
  async ({ browser }) => {
    if (entry === undefined || fixture === undefined) throw new Error('No chip suggested fixture.');
    const { page, close } = await coarsePage(browser);
    try {
      const query = new URLSearchParams({
        snapshot: '1',
        fixture: 'suggested',
        fixtureContentHash: fixture.fixtureContentHash,
      });
      await page.goto(`${entry.route}?${query.toString()}`, { waitUntil: 'load' });
      expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(true);
      const suggested = page.getByTestId('suggested-toggle').locator('button');
      const plain = page.getByTestId('plain-toggle').locator('button');
      const box = await suggested.boundingBox();
      expect(box?.height).toBeLessThanOrEqual(36);
      const centerX = (box?.x ?? 0) + (box?.width ?? 0) / 2;
      const centerY = (box?.y ?? 0) + (box?.height ?? 0) / 2;
      await page.mouse.click(centerX, centerY - 21);
      await expect(suggested).toHaveAttribute('aria-pressed', 'true');
      await page.mouse.click(centerX, centerY + 21);
      await expect(suggested).toHaveAttribute('aria-pressed', 'false');
      await plain.click();
      await expect(plain).toHaveAttribute('aria-pressed', 'true');
      await expect(suggested).toHaveAttribute('aria-pressed', 'false');
    } finally {
      await close();
    }
  },
);
