import { loadManifest, type Viewport } from '@lostgradient/testing';
import type { Page } from '@playwright/test';
import { expect, test } from '@lostgradient/testing/browser/component-page-fixture';

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

async function spacePixels(page: Page, length: string): Promise<number> {
  return page.evaluate((value) => {
    const probe = document.createElement('div');
    probe.style.width = value;
    probe.style.position = 'absolute';
    document.body.append(probe);
    const width = probe.getBoundingClientRect().width;
    probe.remove();
    return width;
  }, length);
}

function spaceTwoPixels(page: Page): Promise<number> {
  return spacePixels(page, 'var(--cinder-space-2)');
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

    test('lists five sources together in order, links only safe addresses and fits the screen', async ({
      componentPage,
    }) => {
      const page = await openHierarchy(componentPage, viewport);
      const requests: string[] = [];
      page.on('request', (request) => {
        if (!request.url().startsWith(new URL(page.url()).origin)) requests.push(request.url());
      });
      await page.getByRole('button', { name: 'Five sources (5)' }).click();
      const panel = page.locator('.cinder-citation__panel');
      await expect(panel).toBeVisible();

      await expect(panel.locator('.cinder-citation__pagination')).toHaveCount(0);
      const items = panel.locator('ol > li');
      await expect(items).toHaveCount(5);
      await expect(items.nth(0).locator('strong')).toHaveText('Annual report');
      await expect(items.nth(3).locator('strong')).toHaveText('Board minutes');
      // The whole row is the one link: its name is its title, host and excerpt, and no separate
      // "Open …" link sits beside it.
      await expect(items.nth(0).getByRole('link')).toHaveCount(1);
      await expect(items.nth(0).getByRole('link')).toHaveAccessibleName(
        'Annual report example.com Revenue rose 12% in 2025.',
      );
      await expect(items.nth(0).locator('a > .cinder-citation__row-text strong')).toHaveCount(1);
      await expect(panel.getByRole('link', { name: /^Open / })).toHaveCount(0);
      await expect(items.nth(1).locator('.cinder-citation__note')).toHaveText(
        'Internal document, no public link',
      );
      await expect(items.nth(2).locator('a')).toHaveCount(0);
      await expect(items.nth(2).locator('.cinder-citation__note')).toHaveText(
        "Link hidden: the address isn't a safe web link",
      );

      // A row's words start on the surface's content edge, where a heading above the list starts:
      // the row's own inset overhangs into the surface's padding.
      const edges = await panel.evaluate((element) => {
        const surface = element.parentElement!;
        const style = getComputedStyle(surface);
        const rtl = style.direction === 'rtl';
        const box = surface.getBoundingClientRect();
        const title = element.querySelector('.cinder-citation__title')!.getBoundingClientRect();
        return rtl
          ? {
              surface:
                box.right -
                Number.parseFloat(style.borderRightWidth) -
                Number.parseFloat(style.paddingRight),
              title: title.right,
            }
          : {
              surface:
                box.left +
                Number.parseFloat(style.borderLeftWidth) +
                Number.parseFloat(style.paddingLeft),
              title: title.left,
            };
      });
      expect(Math.abs(edges.title - edges.surface)).toBeLessThanOrEqual(0.5);

      // A long unbroken title is clamped to two lines.
      const title = await items
        .nth(2)
        .locator('strong')
        .evaluate((element) => ({
          height: element.getBoundingClientRect().height,
          lineHeight: Number.parseFloat(getComputedStyle(element).lineHeight),
        }));
      expect(title.height).toBeLessThanOrEqual(title.lineHeight * 2 + 1);

      const overflow = await page.evaluate(() => {
        const element = document.querySelector('.cinder-citation__panel')!;
        return {
          panel: element.scrollWidth - element.clientWidth,
          document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      });
      expect(overflow.panel).toBeLessThanOrEqual(0);
      expect(overflow.document).toBeLessThanOrEqual(0);
      expect(requests).toEqual([]);
    });

    test('adds no excerpt box or gap for a title-only source', async ({ componentPage }) => {
      const page = await openHierarchy(componentPage, viewport);
      await page.getByRole('button', { name: 'Title only (1)' }).click();
      const panel = page.locator('.cinder-citation__panel');
      await expect(panel).toBeVisible();

      await expect(panel.locator('.cinder-citation__detail')).toHaveCount(0);
      await expect(panel.locator('.cinder-citation__title')).toHaveText('Refund policy');
      // COR-2257 (X6): a source with no address says so under its title, with no link.
      await expect(panel.locator('.cinder-citation__note')).toHaveText(
        'Internal document, no public link',
      );
      await expect(panel.locator('a')).toHaveCount(0);
      // The panel is its row: the row's block padding (two of space-2) round the title, the
      // row's text gap (space-1) and the note. An excerpt box or an excerpt-sized gap would add
      // a whole line more than this.
      const padding = await spaceTwoPixels(page);
      const textGap = await spacePixels(page, 'var(--cinder-space-1)');
      const heights = await panel.evaluate((element) => ({
        panel: element.getBoundingClientRect().height,
        title: element.querySelector('.cinder-citation__title')!.getBoundingClientRect().height,
        note: element.querySelector('.cinder-citation__note')!.getBoundingClientRect().height,
      }));
      expect(heights.panel).toBeLessThanOrEqual(
        heights.title + textGap + heights.note + 2 * padding + 0.5,
      );
    });
  });
}
