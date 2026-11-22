/// <reference lib="dom" />
/**
 * JsonViewer disclosures are real 44px coarse-pointer boxes so neighboring and nested branches
 * cannot share an invisible hit area. Layout requires Chromium; happy-dom covers the CSS contract.
 */

import { fixtureRoute } from '@lostgradient/testing/playwright/overlay-fixture';
import { expect, test, type Browser, type Page } from '@playwright/test';

const TOUCH_TARGET = 44;

async function coarsePage(browser: Browser): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 1,
    viewport: { width: 390, height: 844 },
  });
  return { page: await context.newPage(), close: () => context.close() };
}

test('coarse JsonViewer disclosures are disjoint targets and activate only their branch', async ({
  browser,
}) => {
  const { page, close } = await coarsePage(browser);
  try {
    await page.goto(fixtureRoute('json-viewer', { fixtureName: 'touch-targets' }), {
      waitUntil: 'load',
    });
    const fixture = page.getByTestId('json-viewer-touch-targets');
    const root = fixture.getByRole('button', { name: 'object, 2 items', exact: true });
    const alpha = fixture.getByRole('button', { name: 'alpha: object, 1 item', exact: true });
    const beta = fixture.getByRole('button', { name: 'beta: object, 1 item', exact: true });
    const nested = fixture
      .getByRole('treeitem', { name: 'alpha: object, 1 item', exact: true })
      .getByRole('button', { name: 'nested: object, 1 item', exact: true });
    await expect(nested).toBeVisible();
    expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(true);

    const boxes = await Promise.all(
      [root, alpha, nested, beta].map((button) => button.boundingBox()),
    );
    for (const box of boxes) {
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(TOUCH_TARGET);
      expect(box!.height).toBeGreaterThanOrEqual(TOUCH_TARGET);
    }
    for (let first = 0; first < boxes.length; first += 1) {
      for (let second = first + 1; second < boxes.length; second += 1) {
        const a = boxes[first]!;
        const b = boxes[second]!;
        const overlaps =
          a.x < b.x + b.width &&
          b.x < a.x + a.width &&
          a.y < b.y + b.height &&
          b.y < a.y + a.height;
        expect(overlaps).toBe(false);
      }
    }

    await nested.click();
    await expect(nested).toHaveAttribute('aria-expanded', 'true');
    await expect(alpha).toHaveAttribute('aria-expanded', 'true');
    await expect(beta).toHaveAttribute('aria-expanded', 'true');
    await beta.click();
    await expect(beta).toHaveAttribute('aria-expanded', 'false');
    await expect(alpha).toHaveAttribute('aria-expanded', 'true');
    await expect(root).toHaveAttribute('aria-expanded', 'true');
  } finally {
    await close();
  }
});
