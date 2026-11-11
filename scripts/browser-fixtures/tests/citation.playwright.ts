import { loadManifest, type Viewport } from '@lostgradient/testing';
import type { Page } from '@playwright/test';
import { expect, test } from './component-page-fixture.ts';

const citationEntry = loadManifest().find((entry) => entry.slug === 'citation');

if (!citationEntry) {
  throw new Error('Cached testing manifest does not include slug "citation".');
}

const entry = citationEntry;
const viewports = [
  { name: 'mobile', width: 320, height: 640 },
  { name: 'desktop', width: 1440, height: 900 },
] as const satisfies readonly Viewport[];

type ComponentPage = {
  open(args: { entry: typeof entry; theme: 'light'; viewport: Viewport }): Promise<Page>;
};

async function openHierarchy(componentPage: ComponentPage, viewport: Viewport): Promise<Page> {
  const page = await componentPage.open({ entry, theme: 'light', viewport });
  const fixture = entry.fixtures?.find((candidate) => candidate.name === 'assertion');
  const query = new URLSearchParams({ snapshot: '1', fixture: 'assertion', hierarchy: '1' });
  if (fixture !== undefined) query.set('fixtureContentHash', fixture.fixtureContentHash);
  await page.goto(`${entry.route}?${query.toString()}`, { waitUntil: 'load' });
  await expect(page.getByRole('button', { name: 'Title only (1)' })).toBeVisible();
  return page;
}

async function spaceTwoPixels(page: Page): Promise<number> {
  return page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.width = 'var(--cinder-space-2)';
    probe.style.position = 'absolute';
    document.body.append(probe);
    const width = probe.getBoundingClientRect().width;
    probe.remove();
    return width;
  });
}

for (const viewport of viewports) {
  test.describe(`Citation title and excerpt at ${viewport.width}px`, () => {
    test('separates a long unbroken title from its excerpt and keeps both inside the panel', async ({
      componentPage,
    }) => {
      const page = await openHierarchy(componentPage, viewport);
      await page.getByRole('button', { name: 'Title and excerpt (1)' }).click();
      const panel = page.locator('.cinder-citation__panel');
      await expect(panel).toBeVisible();

      const panelBox = await panel.boundingBox();
      const titleBox = await panel.locator('.cinder-citation__title').boundingBox();
      const detailBox = await panel.locator('.cinder-citation__detail').boundingBox();
      expect(panelBox).not.toBeNull();
      expect(titleBox).not.toBeNull();
      expect(detailBox).not.toBeNull();

      const gap = await spaceTwoPixels(page);
      expect(detailBox!.y - (titleBox!.y + titleBox!.height)).toBeGreaterThanOrEqual(gap - 0.5);
      for (const box of [titleBox!, detailBox!]) {
        expect(box.x).toBeGreaterThanOrEqual(panelBox!.x - 0.5);
        expect(box.x + box.width).toBeLessThanOrEqual(panelBox!.x + panelBox!.width + 0.5);
      }

      const weights = await panel.evaluate((element) => ({
        title: Number(
          getComputedStyle(element.querySelector('.cinder-citation__title')!).fontWeight,
        ),
        detail: Number(
          getComputedStyle(element.querySelector('.cinder-citation__detail')!).fontWeight,
        ),
      }));
      expect(weights.title).toBeGreaterThan(weights.detail);

      const overflow = await page.evaluate(() => {
        const element = document.querySelector('.cinder-citation__panel')!;
        return {
          panel: element.scrollWidth - element.clientWidth,
          document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
      expect(overflow.panel).toBeLessThanOrEqual(0);
      expect(overflow.document).toBeLessThanOrEqual(0);
      expect(panelBox!.x).toBeGreaterThanOrEqual(0);
      expect(panelBox!.x + panelBox!.width).toBeLessThanOrEqual(viewport.width + 0.5);
    });

    test('adds no excerpt box or gap for a title-only source', async ({ componentPage }) => {
      const page = await openHierarchy(componentPage, viewport);
      await page.getByRole('button', { name: 'Title only (1)' }).click();
      const panel = page.locator('.cinder-citation__panel');
      await expect(panel).toBeVisible();

      await expect(panel.locator('.cinder-citation__detail')).toHaveCount(0);
      await expect(panel.locator('.cinder-citation__title')).toHaveText('Refund policy');
      const heights = await panel.evaluate((element) => ({
        panel: element.getBoundingClientRect().height,
        title: element.querySelector('.cinder-citation__title')!.getBoundingClientRect().height,
      }));
      expect(heights.panel).toBeLessThanOrEqual(heights.title + 0.5);
    });
  });
}
