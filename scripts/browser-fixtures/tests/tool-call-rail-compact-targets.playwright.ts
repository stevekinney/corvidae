/// <reference lib="dom" />
/** COR-2403: compact ToolCallRail faces keep their real targets without stealing adjacent rows. */

import { fixtureRoute } from '@lostgradient/testing/playwright/overlay-fixture';
import { expect, test, type Browser, type Page } from '@playwright/test';

async function open(page: Page): Promise<void> {
  await page.goto(fixtureRoute('tool-call-rail'), { waitUntil: 'load' });
  await page.getByTestId('tool-call-rail-targets').waitFor();
}

async function coarsePage(browser: Browser): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 1,
    viewport: { width: 320, height: 640 },
  });
  return { page: await context.newPage(), close: () => context.close() };
}

test('the desktop summary has a 24px target without reaching its first row', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await open(page);
  const summary = page.locator('button.cinder-tool-call-rail__summary');
  const firstRow = page.locator('[data-cinder-tool-call-row="linked"]');
  const [summaryBox, firstRowBox] = await Promise.all([
    summary.boundingBox(),
    firstRow.boundingBox(),
  ]);
  expect(summaryBox?.height).toBeLessThanOrEqual(24);
  expect((firstRowBox?.y ?? 0) - (summaryBox?.y ?? 0) - (summaryBox?.height ?? 0)).toBeGreaterThan(
    2,
  );
  await page.mouse.click(
    (summaryBox?.x ?? 0) + 4,
    (summaryBox?.y ?? 0) + (summaryBox?.height ?? 0) + 1,
  );
  await expect(summary).toHaveAttribute('aria-expanded', 'false');
});

test('coarse two-line rows stay compact and retain adjacent and linked ownership', async ({
  browser,
}) => {
  const { page, close } = await coarsePage(browser);
  try {
    await open(page);
    const waiting = page.locator('[data-cinder-tool-call-row="waiting"]');
    const adjacent = page.locator('[data-cinder-tool-call-row="adjacent"]');
    const waitingBox = await waiting.boundingBox();
    expect(waitingBox?.height).toBeGreaterThanOrEqual(44);
    expect(waitingBox?.height).toBeLessThanOrEqual(48);
    await expect(waiting).toHaveText(/Issue refund.*Waiting on you/);
    await adjacent.click({ position: { x: 8, y: 22 } });
    await expect(adjacent).toHaveAttribute('aria-pressed', 'true');
    await expect(waiting).toHaveAttribute('aria-pressed', 'false');
    await page.locator('.cinder-tool-call-rail__result-link').click();
    await expect(page).toHaveURL(/#linked-result$/);
  } finally {
    await close();
  }
});
