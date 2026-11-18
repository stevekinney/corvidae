/// <reference lib="dom" />
/**
 * COR-2327 and COR-2431 (row 63m): a Dropdown item with a second line, a disabled item's
 * `disabledReason` or an item's `description`, draws it under its label, in the muted text colour,
 * starting where the label's text starts (past a leading icon, or at the item's own start without
 * one), with no hover, at a phone's width and a desktop's. The item is a grid of an icon column
 * and a text column, so nothing is measured to place the line. The item's name is the label and
 * its description is the line. Measured on the `dropdown` assertion fixture with
 * `?disabled-reason=1`, which leaves the default fixture's baselines alone; the boxes are read in
 * one pass once the menu is open.
 */

import { expect, test } from '@playwright/test';
import { fixtureRoute } from './overlay-fixture.ts';

for (const width of [320, 375, 1280]) {
  test(`at ${width}px an item's second line starts where its label's text starts, in the muted colour`, async ({
    page,
  }) => {
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
    await expect(
      page.getByRole('menuitem', { name: 'Pause', exact: true }),
    ).toHaveAccessibleDescription('Runs in flight finish. No new runs start until you resume it.');

    const read = await page.evaluate(() => {
      const measure = (item: Element) => {
        // The label is `display: contents`, so its words are measured, never its box.
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
        const reasonBox = reason.getBoundingClientRect();
        const itemBox = item.getBoundingClientRect();
        const contentStart = itemBox.left + Number.parseFloat(getComputedStyle(item).paddingLeft);
        const probe = document.createElement('span');
        probe.style.color = 'var(--cinder-text-muted)';
        item.append(probe);
        const muted = getComputedStyle(probe).color;
        probe.remove();
        return {
          textLeft: text.left,
          textBottom: text.bottom,
          contentStart,
          reasonTop: reasonBox.top,
          reasonTextLeft: reasonText.left,
          reasonColor: getComputedStyle(reason).color,
          muted,
          visible: reasonBox.height > 0,
        };
      };
      const items = [...document.querySelectorAll('.cinder-dropdown-item[data-cinder-reason]')];
      return items.map(measure);
    });

    // Branch, Archive (each after an icon), Export (no icon) and Pause (an icon, enabled).
    expect(read).toHaveLength(4);
    for (const item of read) {
      expect(item.visible).toBe(true);
      expect(item.reasonTop).toBeGreaterThanOrEqual(item.textBottom - 0.5);
      expect(Math.abs(item.reasonTextLeft - item.textLeft)).toBeLessThan(1);
      expect(item.reasonColor).toBe(item.muted);
    }
    // With an icon the line starts past it; without one, at the item's own content start.
    expect(read[0]!.reasonTextLeft).toBeGreaterThan(read[0]!.contentStart + 10);
    expect(read[3]!.reasonTextLeft).toBeGreaterThan(read[3]!.contentStart + 10);
    expect(Math.abs(read[2]!.reasonTextLeft - read[2]!.contentStart)).toBeLessThan(1);
  });
}
