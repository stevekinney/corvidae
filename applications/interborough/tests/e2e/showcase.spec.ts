/**
 * Every route in the route table, and the states the showcase seed gives a few of them, at 375, 768
 * and 1280 pixels, holding believable content (`fixtures/showcase-seed.ts`) instead of the stress
 * seed's 300-character words (`responsive.spec.ts`). The design review (`.agents/skills/design-review`)
 * captures these screens for layout, hierarchy and density.
 *
 * The specification seeds the host once, opens each address, waits until the page's frame is `ready`
 * and the outlet has stopped changing, asserts no frame is `empty`, and captures the page
 * (`design-review-capture.ts`) when a capture directory is set. It removes what it seeded afterwards.
 */
import type { Page } from '@playwright/test';

import { removeShowcase, seedShowcase, type ShowcaseSeed } from '../../fixtures/showcase-seed.ts';
import { routes } from '../../src/app/routes.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, goOffline, test } from './fixtures.ts';
import { showcaseAddresses, showcaseVariantNames, showcaseVariants } from './showcase-routes.ts';

const WIDTHS = [375, 768, 1280] as const;
const HEIGHT = 900;

let seed: ShowcaseSeed;
let addresses: Readonly<Record<string, string>>;

/** Waits until the outlet's text and busy state have stopped changing for three reads in a row. */
async function untilQuiet(page: Page): Promise<void> {
  const outlet = page.locator('main.weft-shell-outlet');
  let previous = '';
  let streak = 0;
  await expect
    .poll(
      async () => {
        const text = await outlet.innerText();
        const busy = await outlet.locator('[aria-busy="true"]').count();
        const signature = `${busy}:${text.length}`;
        streak = signature === previous && busy === 0 ? streak + 1 : 0;
        previous = signature;
        return streak;
      },
      { intervals: [150] },
    )
    .toBeGreaterThanOrEqual(3);
}

test.beforeAll(async () => {
  seed = await seedShowcase(E2E_SHOWCASE_URL);
  addresses = { ...showcaseAddresses(seed), ...showcaseVariants(seed) };
});

test.afterAll(async () => {
  if (seed !== undefined) await removeShowcase(E2E_SHOWCASE_URL, seed);
});

test('gives every route in the table an address', () => {
  const patterns = routes.filter((route) => route.redirect === undefined).map((r) => r.pattern);
  for (const pattern of patterns) expect(addresses, pattern).toHaveProperty([pattern]);
});

const NAMES = [
  ...routes.filter((route) => route.redirect === undefined).map((route) => route.pattern),
  ...showcaseVariantNames(),
];

for (const name of NAMES) {
  test(`${name} holds believable content at 375, 768 and 1280 pixels`, async ({ page }) => {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: HEIGHT });
      await page.goto(`${E2E_SHOWCASE_URL}${addresses[name]}`);
      const outlet = page.locator('main.weft-shell-outlet');
      await expect(outlet).toBeVisible();
      const frame = outlet.locator('[data-view]').first();
      await expect(frame, `${name} at ${width}px`).toHaveAttribute('data-state', 'ready');
      await untilQuiet(page);
      await expect(frame, `${name} at ${width}px stays ready`).toHaveAttribute(
        'data-state',
        'ready',
      );
      await captureForDesignReview(page, {
        route: name,
        state: 'ready',
        source: 'showcase.spec.ts',
      });
    }
  });
}

/** Routes whose offline state the design draws: a list, a detail page and a form page. */
const OFFLINE_ROUTES = ['/runs', '/capabilities', '/agents'] as const;

for (const name of OFFLINE_ROUTES) {
  test(`${name} shows the offline banner over its old data at 375 and 1280 pixels`, async ({
    page,
    context,
    pageErrors,
  }) => {
    for (const width of [375, 1280] as const) {
      await page.setViewportSize({ width, height: HEIGHT });
      await page.goto(`${E2E_SHOWCASE_URL}${addresses[name]}`);
      const frame = page.locator('main.weft-shell-outlet [data-view]').first();
      await expect(frame, `${name} at ${width}px`).toHaveAttribute('data-state', 'ready');
      await untilQuiet(page);

      await goOffline(context, pageErrors);
      await page.evaluate(() => {
        window.dispatchEvent(new Event('offline'));
        window.dispatchEvent(new Event('visibilitychange'));
      });
      const banner = page.getByRole('region', { name: 'Connection problem' });
      await expect(banner, `${name} at ${width}px offline`).toBeVisible();
      await expect(frame).toHaveAttribute('data-state', 'ready');
      await captureForDesignReview(page, {
        route: name,
        state: 'offline',
        source: 'showcase.spec.ts',
      });

      await context.setOffline(false);
      await expect(banner, `${name} at ${width}px back online`).toHaveCount(0);
    }
  });
}
