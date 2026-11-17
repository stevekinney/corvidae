/**
 * COR-2327: a toast sits above the chat's docked area (the composer, or the blocked row that stands
 * in for it, with the approval reminder above), at every width. Chat marks that area with Cinder's
 * `dockedToBottom()`, so the toast region's offset (`--_cinder-docked-action-bar-height` on the
 * document element) reaches from the bottom of the viewport to the area's top edge, past a phone's
 * tab bar under it. Read on the sample world's refund chat (`fixtures/sample-world-seed.ts`), whose
 * composer is the blocked row because the sample world holds no provider key.
 */
import type { Page } from '@playwright/test';

import { SAMPLE_NOW, SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { SAMPLE_WORLD_THREADS } from '../../fixtures/sample-world-records.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

/** How far the toast region is lifted, and how far from the bottom the docked area's top is. */
async function readClearance(page: Page): Promise<{ lifted: number; dockTop: number }> {
  return page.evaluate(() => {
    const area = document.querySelector('.chat-input-area');
    const lifted = Number.parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue(
        '--_cinder-docked-action-bar-height',
      ),
    );
    const top = area?.getBoundingClientRect().top ?? Number.NaN;
    return { lifted: Number.isFinite(lifted) ? lifted : 0, dockTop: window.innerHeight - top };
  });
}

for (const viewport of [
  { width: 375, height: 812 },
  { width: 1280, height: 900 },
]) {
  test(`at ${viewport.width}px the toasts are lifted above the chat's docked area`, async ({
    page,
  }) => {
    await page.clock.setFixedTime(SAMPLE_NOW);
    await page.setViewportSize(viewport);
    await page.goto(`/chats/${SAMPLE_WORLD_THREADS.refund}`);
    await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('.chat-input-area')).toBeVisible();

    // The offset follows the area as the page settles, so it is read until the two agree; a
    // failure prints both numbers.
    await expect
      .poll(async () => {
        const { lifted, dockTop } = await readClearance(page);
        return `lifted ${Math.round(lifted)}px, dock top ${Math.ceil(dockTop)}px from the bottom`;
      })
      .toMatch(/^lifted (\d+)px, dock top \1px from the bottom$/);
  });
}
