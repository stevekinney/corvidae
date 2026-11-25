/// <reference lib="dom" />
/**
 * COR-2327: a disabled Dropdown item with a `disabledReason` draws the reason as a second line under
 * its label, never louder than the label it explains (COR-2680), starting where the label's text starts (past a leading icon,
 * or at the label's own start without one), with no hover, at a phone's width and a desktop's. The
 * item's name is the label and its description is the reason. Measured on the `dropdown` assertion
 * fixture with `?disabled-reason=1`, which leaves the default fixture's baselines alone; the boxes
 * are read in one pass once the menu is open.
 */

import { THEME_STORAGE_KEY, themeContextOptions } from '@lostgradient/testing';
import { fixtureRoute } from '@lostgradient/testing/playwright/overlay-fixture';
import { expect, test } from '@playwright/test';

import { toneOf } from './reason-tone-support.ts';

for (const theme of ['light', 'dark'] as const) {
  test.describe(`${theme} theme`, () => {
    test.use(themeContextOptions(theme));
    for (const width of [375, 1280]) {
      test(`at ${width}px a disabled item's reason is a second line under its label text, quieter than the label`, async ({
        page,
      }) => {
        await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [
          THEME_STORAGE_KEY,
          theme,
        ] as const);
        await page.setViewportSize({ width, height: 800 });
        await page.goto(`${fixtureRoute('dropdown')}&disabled-reason=1`, { waitUntil: 'load' });
        await page.getByRole('button', { name: 'Chat actions' }).click();
        const archive = page.getByRole('menuitem', { name: 'Archive', exact: true });
        await expect(archive).toBeVisible();
        await expect(archive).toHaveAccessibleDescription(
          'Wait for the run to finish or stop it, then archive the chat.',
        );
        await expect(
          page.getByRole('menuitem', { name: 'Branch from the last reply', exact: true }),
        ).toHaveAccessibleDescription('There is no finished reply to branch from yet.');

        const readItems = () =>
          page.evaluate(() => {
            const measure = (item: Element) => {
              const label = item.querySelector('.cinder-dropdown-item__label')!;
              const reason = item.querySelector<HTMLElement>('.cinder-dropdown-item__reason')!;
              const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT, {
                acceptNode: (node) =>
                  node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
              });
              const range = document.createRange();
              range.selectNodeContents(walker.nextNode()!);
              const text = range.getBoundingClientRect();
              const reasonRange = document.createRange();
              reasonRange.selectNodeContents(reason);
              const reasonText = reasonRange.getClientRects()[0]!;
              const labelBox = label.getBoundingClientRect();
              const reasonBox = reason.getBoundingClientRect();
              return {
                textLeft: text.left,
                labelLeft: labelBox.left,
                labelBottom: labelBox.bottom,
                reasonTop: reasonBox.top,
                reasonTextLeft: reasonText.left,
                visible: reasonBox.height > 0,
              };
            };
            const items = [
              ...document.querySelectorAll('.cinder-dropdown-item[data-cinder-reason]'),
            ];
            return items.map(measure);
          });

        // The indent past an icon is measured once the open menu is laid out, so the read waits for
        // the menu to settle with every reason line under its label's text, then reads it once.
        await expect
          .poll(async () => {
            const items = await readItems();
            return items.every((item) => Math.abs(item.reasonTextLeft - item.textLeft) < 1);
          })
          .toBe(true);
        const read = await readItems();

        // Branch, Archive (each after an icon) and Export (no icon).
        expect(read).toHaveLength(3);
        for (const item of read) {
          expect(item.visible).toBe(true);
          expect(item.reasonTop).toBeGreaterThanOrEqual(item.labelBottom - 0.5);
          expect(Math.abs(item.reasonTextLeft - item.textLeft)).toBeLessThan(1);
        }
        // With an icon the reason starts past it; without one, at the label's own start.
        expect(read[0]!.reasonTextLeft).toBeGreaterThan(read[0]!.labelLeft + 10);
        expect(Math.abs(read[2]!.reasonTextLeft - read[2]!.labelLeft)).toBeLessThan(1);

        // COR-2680: a reason never reads louder than the label it explains: no more contrast, smaller.
        for (const item of await page.locator('.cinder-dropdown-item[data-cinder-reason]').all()) {
          const label = await item.locator('.cinder-dropdown-item__label').evaluate(toneOf);
          const reason = await item.locator('.cinder-dropdown-item__reason').evaluate(toneOf);
          expect(reason.contrast).toBeLessThanOrEqual(label.contrast + 0.01);
          expect(reason.fontSize).toBeLessThan(label.fontSize);
        }
      });
    }
  });
}
