/// <reference lib="dom" />
/**
 * COR-2770: Breadcrumbs draws its phone form on the first paint. Both forms are in the server HTML
 * (the whole trail and the phone form's back link) and Cinder's CSS shows one of them, so a page
 * with no script at all is already the right layout at 375px and at 1280px.
 *
 * The fixture host mounts on the client, so these tests render `server-rendered/breadcrumbs.svelte`
 * with the real server runtime and serve it inside the host's built page with JavaScript off
 * (`scripts/server-rendered-page.ts`). The last test compares that first paint with the hydrated
 * `breadcrumbs` fixture, which draws the same trail.
 */

import { fixtureRoute } from '@lostgradient/testing/playwright/overlay-fixture';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  openServerRenderedPage,
  renderServerPage,
  type ServerRenderedPage,
} from '../scripts/server-rendered-page.ts';

const SOURCE = new URL('./server-rendered/breadcrumbs.svelte', import.meta.url).pathname;
const PATH = '/server-rendered/breadcrumbs';
const ANCESTORS = [
  { label: 'Home', href: '/' },
  { label: 'Projects', href: '/projects' },
  { label: 'Cinder', href: '/projects/cinder' },
];
const WIDE_WORDS = ['Home', '/', 'Projects', '/', 'Cinder', '/', 'Settings'];
const PHONE_WORDS = ['Cinder', 'Settings'];

let rendered: ServerRenderedPage;

test.beforeAll(async () => {
  rendered = await renderServerPage(SOURCE);
});

test.use({ javaScriptEnabled: false });

async function openFirstPaint(page: Page, width: number): Promise<Locator> {
  await page.setViewportSize({ width, height: 800 });
  await openServerRenderedPage(page, rendered, { path: PATH });
  return page.locator('nav.cinder-breadcrumbs');
}

/** The trail's visible words: `innerText` leaves out whatever `display: none` hides. */
async function visibleWords(trail: Locator): Promise<string[]> {
  const text = await trail.evaluate((element) => (element as HTMLElement).innerText);
  return text.split(/\s+/u).filter((word) => word !== '');
}

async function expectServedTrail(page: Page): Promise<void> {
  // The served HTML holds the whole trail and the back link, so a client-only page fails here
  // instead of passing every visibility check below by having nothing to hide.
  const links = page.locator('a.cinder-breadcrumbs__link');
  await expect(links).toHaveCount(ANCESTORS.length);
  for (const [index, ancestor] of ANCESTORS.entries()) {
    await expect(links.nth(index)).toHaveAttribute('href', ancestor.href);
    await expect(links.nth(index)).toHaveText(ancestor.label);
  }
  await expect(page.locator('a.cinder-breadcrumbs__back')).toHaveCount(1);
  await expect(page.locator('[aria-current="page"]')).toHaveCount(1);
}

test('with no script, a 375px viewport paints the back link and the current page only', async ({
  page,
}) => {
  const trail = await openFirstPaint(page, 375);
  await expectServedTrail(page);

  const back = page.locator('a.cinder-breadcrumbs__back');
  await expect(back).toBeVisible();
  await expect(back).toHaveText('Cinder');
  await expect(back).toHaveAttribute('href', '/projects/cinder');
  await expect(page.locator('[aria-current="page"]')).toBeVisible();
  for (const link of await page.locator('a.cinder-breadcrumbs__link').all()) {
    await expect(link).toBeHidden();
  }
  expect(await visibleWords(trail)).toEqual(PHONE_WORDS);
});

test('with no script, a 1280px viewport paints the whole trail and no back link', async ({
  page,
}) => {
  const trail = await openFirstPaint(page, 1280);
  await expectServedTrail(page);

  for (const link of await page.locator('a.cinder-breadcrumbs__link').all()) {
    await expect(link).toBeVisible();
  }
  await expect(page.locator('a.cinder-breadcrumbs__back')).toBeHidden();
  await expect(page.locator('[aria-current="page"]')).toBeVisible();
  expect(await visibleWords(trail)).toEqual(WIDE_WORDS);
});

for (const width of [375, 1280]) {
  test(`at ${width}px the first paint is the hydrated layout`, async ({ page, browser }) => {
    const firstPaintTrail = await openFirstPaint(page, width);
    const firstPaint = await firstPaintTrail.boundingBox();

    const context = await browser.newContext({
      javaScriptEnabled: true,
      viewport: { width, height: 800 },
    });
    try {
      const hydratedPage = await context.newPage();
      await hydratedPage.goto(fixtureRoute('breadcrumbs'), { waitUntil: 'load' });
      const trail = hydratedPage.locator('nav.cinder-breadcrumbs');
      await trail.waitFor({ state: 'visible' });
      const hydrated = await trail.boundingBox();

      expect(firstPaint).not.toBeNull();
      expect(hydrated).not.toBeNull();
      expect(Math.abs(firstPaint!.y - hydrated!.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(firstPaint!.height - hydrated!.height)).toBeLessThanOrEqual(1);
    } finally {
      await context.close();
    }
  });
}
