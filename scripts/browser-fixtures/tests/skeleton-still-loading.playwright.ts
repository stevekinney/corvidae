/// <reference lib="dom" />
/**
 * COR-2489: a placeholder's slow-load line holds the placeholder's place, so nothing under it moves
 * when the line appears, and its Cancel, the one way out of a slow load, is never cut short on a
 * phone. A list that leads with a day band keeps the band's words in view. happy-dom performs no
 * layout, so it is measured here.
 */

import { expect, test } from '@playwright/test';
import { fixtureRoute } from './overlay-fixture.ts';

const WIDTHS = [320, 375, 1280] as const;

for (const width of WIDTHS) {
  test.describe(`the slow-load line at ${width}px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: 1200 });
      await page.goto(fixtureRoute('skeleton', { fixtureName: 'still-loading' }), {
        waitUntil: 'load',
      });
    });

    for (const variant of ['bars', 'card', 'form'] as const) {
      test(`the ${variant} placeholder is as tall with the line as without it`, async ({
        page,
      }) => {
        const sample = page.getByTestId(`still-loading-${variant}`);
        await expect(sample.locator('[data-testid="slow"] .cinder-skeleton-status')).toContainText(
          'Still loading.',
        );
        const height = (testId: string) =>
          sample.getByTestId(testId).evaluate((element) => element.getBoundingClientRect().height);
        expect(await height('slow')).toBeCloseTo(await height('plain'), 0);
      });

      test(`the ${variant} placeholder's Cancel reads whole`, async ({ page }) => {
        const cancel = page
          .getByTestId(`still-loading-${variant}`)
          .getByRole('button', { name: 'Cancel' });
        await expect(cancel).toBeVisible();
        const cut = await cancel.evaluate((button) => {
          const label = button.querySelector('span') ?? button;
          return label.scrollWidth > label.clientWidth || button.scrollWidth > button.clientWidth;
        });
        expect(cut).toBe(false);
      });
    }

    test('a list that leads with a day band keeps the band above the line', async ({ page }) => {
      const sample = page.getByTestId('still-loading-day-band');
      const band = await sample
        .locator('.cinder-skeleton-day-band')
        .evaluate((element) => element.getBoundingClientRect().bottom);
      const line = await sample
        .locator('.cinder-skeleton-status')
        .evaluate((element) => element.getBoundingClientRect().top);
      expect(line).toBeGreaterThanOrEqual(band - 1);
    });
  });
}
