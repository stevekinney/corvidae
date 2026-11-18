import { expect, test } from '@playwright/test';
import { fixtureRoute } from './layout-fixture.ts';

// COR-2445 AC3 (COR-2314 AC4): a neutral Callout's actions hold at 360, 768 and 1280 px: they stay
// inside the callout, at its trailing end, with each label on one line and nothing scrolling
// sideways.

for (const width of [360, 768, 1280]) {
  test(`neutral callout actions stay inside the callout at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(fixtureRoute('callout'), { waitUntil: 'load' });
    for (const testId of ['callout-action-inline', 'callout-action-stacked']) {
      // Both sides of every comparison are read in one evaluate, so they come from one layout.
      const measured = await page.getByTestId(testId).evaluate((callout) => {
        const box = callout.getBoundingClientRect();
        const style = getComputedStyle(callout);
        const paddingEnd = Number.parseFloat(style.paddingRight);
        const buttons = [
          ...callout.querySelectorAll<HTMLElement>('.cinder-callout__action button'),
        ];
        return {
          calloutLeft: box.left,
          calloutRight: box.right,
          paddingEnd,
          overflow: callout.scrollWidth - callout.clientWidth,
          buttons: buttons.map((button) => {
            const rect = button.getBoundingClientRect();
            return {
              left: rect.left,
              right: rect.right,
              height: rect.height,
              lineHeight: Number.parseFloat(getComputedStyle(button).lineHeight),
              labelOverflow: button.scrollWidth - button.clientWidth,
            };
          }),
        };
      });
      expect(measured.buttons.length, `${testId} buttons`).toBeGreaterThan(0);
      expect(measured.overflow, `${testId} overflow`).toBeLessThanOrEqual(0);
      for (const button of measured.buttons) {
        expect(button.left, `${testId} left edge`).toBeGreaterThanOrEqual(measured.calloutLeft);
        expect(button.right, `${testId} right edge`).toBeLessThanOrEqual(
          measured.calloutRight - measured.paddingEnd + 1,
        );
        // One line: the button is never taller than two line heights' worth of its own padding.
        expect(button.labelOverflow, `${testId} label`).toBeLessThanOrEqual(0);
        expect(button.height, `${testId} height`).toBeLessThan(button.lineHeight * 2.5);
      }
      // The last action is at the callout's trailing end.
      const last = measured.buttons.at(-1)!;
      expect(
        measured.calloutRight - measured.paddingEnd - last.right,
        `${testId} trailing end`,
      ).toBeLessThanOrEqual(2);
    }
  });
}
