/// <reference lib="dom" />
/**
 * COR-2664: a checked radio or checkbox Dropdown item draws a check mark, and every checkable
 * item keeps the mark's slot while unchecked, so the labels of a group share one start edge (past
 * a leading icon too). The mark is drawn in the item's own colour. Measured on the `dropdown`
 * assertion fixture with `?checkable=1`, which leaves the default fixture's baselines alone, in
 * both themes, anchored at 1280px and docked as a bottom sheet at 375px.
 */

import { THEME_STORAGE_KEY, themeContextOptions } from '@lostgradient/testing';
import { fixtureRoute } from '@lostgradient/testing/playwright/overlay-fixture';
import { expect, test } from '@playwright/test';

type ItemGeometry = {
  name: string;
  checked: string | null;
  slotWidth: number;
  markVisible: boolean;
  markColor: string | null;
  itemColor: string;
  textLeft: number;
  textTop: number;
  slotTop: number;
  slotBottom: number;
};

for (const theme of ['light', 'dark'] as const) {
  test.describe(`${theme} theme`, () => {
    test.use(themeContextOptions(theme));

    for (const { width, docked } of [
      { width: 1280, docked: false },
      { width: 375, docked: true },
    ]) {
      test(`at ${width}px a checked item draws a mark and every label starts at one edge`, async ({
        page,
      }) => {
        await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [
          THEME_STORAGE_KEY,
          theme,
        ] as const);
        await page.setViewportSize({ width, height: 800 });
        await page.goto(`${fixtureRoute('dropdown')}&checkable=1`, { waitUntil: 'load' });
        await page.getByRole('button', { name: 'Namespace' }).click();
        const menu = page.getByRole('menu');
        await expect(page.getByRole('menuitemradio', { name: 'default' })).toBeVisible();
        if (docked) await expect(menu).toHaveAttribute('data-cinder-sheet', 'docked');
        else await expect(menu).not.toHaveAttribute('data-cinder-sheet', 'docked');
        await expect(page.getByRole('menuitemradio', { name: 'default' })).toHaveAttribute(
          'aria-checked',
          'true',
        );

        const items: ItemGeometry[] = await page.evaluate(() => {
          const rows = Array.from(
            document.querySelectorAll<HTMLElement>(
              '[role="menuitemradio"], [role="menuitemcheckbox"]',
            ),
          );
          return rows.map((item) => {
            const slot = item.querySelector<HTMLElement>('.cinder-dropdown-item__check');
            const mark = slot?.querySelector('svg') ?? null;
            const label = item.querySelector('.cinder-dropdown-item__label') ?? item;
            const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT, {
              acceptNode: (node) =>
                node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
            });
            const range = document.createRange();
            range.selectNodeContents(walker.nextNode()!);
            const text = range.getBoundingClientRect();
            const slotBox = slot?.getBoundingClientRect();
            const markBox = mark?.getBoundingClientRect();
            return {
              name: label.textContent?.trim() ?? '',
              checked: item.getAttribute('aria-checked'),
              slotWidth: slotBox?.width ?? 0,
              markVisible: markBox !== undefined && markBox.width > 0 && markBox.height > 0,
              markColor: mark === null ? null : getComputedStyle(mark).color,
              itemColor: getComputedStyle(item).color,
              textLeft: text.left,
              textTop: text.top,
              slotTop: slotBox?.top ?? 0,
              slotBottom: slotBox?.bottom ?? 0,
            };
          });
        });

        // default, payments, billing-reconciliation, temporal-system (disabled), Branch, Author.
        expect(items).toHaveLength(6);
        const radios = items.slice(0, 4);
        const checkboxes = items.slice(4);
        for (const item of items) {
          expect(item.slotWidth).toBeGreaterThan(0);
          expect(Math.abs(item.slotWidth - items[0]!.slotWidth)).toBeLessThan(0.5);
          expect(item.markVisible).toBe(item.checked === 'true');
          if (item.markColor !== null) expect(item.markColor).toBe(item.itemColor);
        }
        expect(radios.map((item) => item.checked)).toEqual(['true', 'false', 'false', 'false']);
        expect(checkboxes.map((item) => item.checked)).toEqual(['true', 'false']);

        // Every radio label starts at one edge, the disabled one with a reason line included.
        for (const item of radios) {
          expect(Math.abs(item.textLeft - radios[0]!.textLeft)).toBeLessThan(1);
        }
        // The checkbox labels follow an icon, so they share their own edge, past the slot.
        expect(Math.abs(checkboxes[0]!.textLeft - checkboxes[1]!.textLeft)).toBeLessThan(1);
        expect(checkboxes[0]!.textLeft).toBeGreaterThan(radios[0]!.textLeft + 10);

        // The disabled item's slot stays on its label's line, above its reason.
        const disabled = radios[3]!;
        expect(disabled.slotBottom).toBeGreaterThan(disabled.textTop);
        const reason = page.locator('.cinder-dropdown-item__reason', {
          hasText: 'This connection cannot read it.',
        });
        await expect(reason).toBeVisible();
        const reasonBox = await reason.boundingBox();
        expect(reasonBox!.y).toBeGreaterThanOrEqual(disabled.slotBottom - 0.5);
        await expect
          .poll(async () =>
            reason.evaluate((element) => {
              const range = document.createRange();
              range.selectNodeContents(element);
              return range.getClientRects()[0]!.left;
            }),
          )
          .toBeCloseTo(disabled.textLeft, 0);

        // Choosing another namespace moves the mark.
        await page.getByRole('menuitemradio', { name: 'payments' }).click();
        await page.getByRole('button', { name: 'Namespace' }).click();
        await expect(page.getByRole('menuitemradio', { name: 'payments' })).toHaveAttribute(
          'aria-checked',
          'true',
        );
        await expect(
          page
            .getByRole('menuitemradio', { name: 'payments' })
            .locator('.cinder-dropdown-item__check svg'),
        ).toBeVisible();
        await expect(
          page
            .getByRole('menuitemradio', { name: 'default' })
            .locator('.cinder-dropdown-item__check svg'),
        ).toHaveCount(0);
      });
    }
  });
}
