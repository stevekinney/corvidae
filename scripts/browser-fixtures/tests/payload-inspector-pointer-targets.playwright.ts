import { fixtureRoute } from '@lostgradient/testing/playwright/overlay-fixture';
import { expect, test, type Locator, type Page } from '@playwright/test';

async function assertVerticalTarget(control: Locator, targetSize: number): Promise<void> {
  await control.scrollIntoViewIfNeeded();
  const edges = await control.evaluate((element, size) => {
    const box = element.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    return [-1, 1].map((direction) =>
      element.contains(document.elementFromPoint(x, y + direction * (size / 2 - 1))),
    );
  }, targetSize);
  expect(edges).toEqual([true, true]);
}

async function activateBottomEdge(page: Page, control: Locator, size: number, touch: boolean) {
  const box = await control.boundingBox();
  if (box === null) throw new Error('The control has no visible box.');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2 + size / 2 - 1;
  if (touch) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

for (const touch of [false, true]) {
  const size = touch ? 44 : 24;
  test.describe(touch ? 'on a phone' : 'with a mouse', () => {
    test.use({ hasTouch: touch, viewport: { width: touch ? 320 : 1280, height: 850 } });

    test.beforeEach(async ({ page }) => {
      await page.goto(`${fixtureRoute('payload-inspector')}&pointer-targets=1`, {
        waitUntil: 'load',
      });
      expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(touch);
    });

    test('a nested Fields disclosure owns its vertical target', async ({ page }) => {
      const payload = page.getByRole('group', { name: 'Checkout payload', exact: true });
      const cart = payload.getByRole('button', { name: /^cart,/i });
      const flags = payload.getByRole('button', { name: /^flags,/i });
      const wasExpanded = await cart.getAttribute('aria-expanded');
      const flagsExpanded = await flags.getAttribute('aria-expanded');

      await assertVerticalTarget(cart, size);
      await activateBottomEdge(page, cart, size, touch);
      await expect(cart).toHaveAttribute(
        'aria-expanded',
        wasExpanded === 'true' ? 'false' : 'true',
      );
      await expect(flags).toHaveAttribute('aria-expanded', flagsExpanded ?? '');
    });

    test('Show all owns its vertical target and expands the full text', async ({ page }) => {
      const payload = page.getByRole('group', { name: 'Long payload', exact: true });
      const showAll = payload.getByRole('button', { name: 'Show all', exact: true });

      await expect(showAll).toHaveAttribute('aria-expanded', 'false');
      await assertVerticalTarget(showAll, size);
      await activateBottomEdge(page, showAll, size, touch);
      await expect(payload.getByRole('button', { name: 'Show less' })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
    });
  });
}

test.describe('a payload header on a phone', () => {
  test.use({ hasTouch: true, viewport: { width: 320, height: 850 } });

  test('JSON and Copy each receive taps at their facing edges', async ({ page }) => {
    await page.goto(fixtureRoute('payload-inspector'), { waitUntil: 'load' });
    const payload = page.getByRole('group', { name: 'Checkout payload', exact: true });
    const json = payload.getByRole('radio', { name: 'JSON' });
    const copy = payload.getByRole('button', { name: /copy/i });
    await expect(json).toBeVisible();
    await expect(copy).toBeVisible();

    const rightEdge = await json.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const x = box.left + box.width / 2 + 21;
      const y = box.top + box.height / 2;
      return { x, y, ownsPoint: element.contains(document.elementFromPoint(x, y)) };
    });
    const copyOwnsItsLeftEdge = await copy.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const x = box.left + box.width / 2 - 21;
      const y = box.top + box.height / 2;
      return element.contains(document.elementFromPoint(x, y));
    });

    expect(rightEdge.ownsPoint).toBe(true);
    expect(copyOwnsItsLeftEdge).toBe(true);
    await page.touchscreen.tap(rightEdge.x, rightEdge.y);
    await expect(json).toBeChecked();
  });
});
