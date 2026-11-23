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
    const rootItem = fixture.getByRole('treeitem', { name: 'object, 2 items', exact: true });
    const alphaItem = fixture.getByRole('treeitem', { name: 'alpha: object, 1 item', exact: true });
    const betaItem = fixture.getByRole('treeitem', { name: 'beta: object, 1 item', exact: true });
    const nestedItem = alphaItem.getByRole('treeitem', {
      name: 'nested: object, 1 item',
      exact: true,
    });
    const nested = nestedItem.getByRole('button', { name: 'nested: object, 1 item', exact: true });
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
    for (const button of [root, alpha, nested, beta]) {
      const edgeOwners = await button.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const centerX = box.left + box.width / 2;
        const centerY = box.top + box.height / 2;
        return (
          [
            [centerX, box.top + 1],
            [centerX, box.bottom - 1],
            [box.left + 1, centerY],
            [box.right - 1, centerY],
          ] as const
        ).map(([x, y]) => element.contains(document.elementFromPoint(x, y)));
      });
      expect(edgeOwners).toEqual([true, true, true, true]);
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

    // Tap the nested button's bottom-edge padding. The state belongs to the owning treeitem, not
    // its activation button; sibling and parent branches must remain open.
    const nestedBox = boxes[2]!;
    await page.touchscreen.tap(
      nestedBox.x + nestedBox.width / 2,
      nestedBox.y + nestedBox.height - 2,
    );
    await expect(nestedItem).toHaveAttribute('aria-expanded', 'true');
    await expect(alphaItem).toHaveAttribute('aria-expanded', 'true');
    await expect(betaItem).toHaveAttribute('aria-expanded', 'true');
    await beta.tap();
    await expect(betaItem).toHaveAttribute('aria-expanded', 'false');
    await expect(alphaItem).toHaveAttribute('aria-expanded', 'true');
    await expect(rootItem).toHaveAttribute('aria-expanded', 'true');
  } finally {
    await close();
  }
});
