/**
 * Every route in the route table that needs no record to address, and every Health tab, read as a
 * person reads it (owner, 2026-11-19): no page shows a filesystem path or home directory in a
 * header, a description or a body sentence, and no page shows a secret reference
 * (`workspace:<ULID>/...`) or a ULID. A path may sit only inside an explicit copy control; the
 * rules and the reading are `src/lib/visible-text-rules.ts`, which the page tests share. Each hit is
 * a fix in the page, never an entry in an allowlist.
 *
 * The walk is at 1280 pixels on the main host and on the first-run host, whose temporary state
 * directories (`/tmp/interborough-e2e-…`, `/var/folders/…`) are exactly the paths a page must not
 * print.
 */
import type { Page } from '@playwright/test';

import { routes } from '../../src/app/routes.ts';
import {
  forbiddenVisibleText,
  PATH_ALLOWED_SELECTOR,
  visibleTextOutsideCopyControls,
} from '../../src/lib/visible-text-rules.ts';
import { E2E_FIRST_RUN_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

/** The addresses that need no record: every pattern without a parameter, and Health's tabs. */
const ADDRESSES = [
  ...new Set([
    ...routes.map((route) => route.pattern).filter((pattern) => !pattern.includes(':')),
    '/health?advanced=open',
  ]),
];

/**
 * What the outlet says outside copy controls, read in the page by the shared reading, which holds
 * no closure, so Playwright sends it to the page as it is.
 */
async function outletText(page: Page): Promise<string> {
  return page
    .locator('main.weft-shell-outlet')
    .evaluate(visibleTextOutsideCopyControls, PATH_ALLOWED_SELECTOR);
}

/** Opens `address` and waits until its outlet holds its content and has stopped changing. */
async function settle(page: Page, address: string): Promise<void> {
  await page.goto(address);
  const outlet = page.locator('main.weft-shell-outlet');
  await expect(outlet).toBeVisible();
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

for (const [host, base] of [
  ['the main host', ''],
  ['the first-run host', E2E_FIRST_RUN_URL],
] as const) {
  test.describe(`no page shows a host path, a secret reference or a ULID, on ${host}`, () => {
    for (const address of ADDRESSES) {
      test(address, async ({ page }) => {
        await page.setViewportSize({ width: 1280, height: 900 });
        await settle(page, `${base}${address}`);
        expect(forbiddenVisibleText(await outletText(page)), address).toEqual([]);
      });
    }
  });
}
