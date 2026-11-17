/// <reference lib="dom" />
/**
 * COR-2449 (AC8): a NumberInput's unit sits beside its number, whether the field takes its own
 * width or a fixed one. Content sizing of the text area needs an automatic width, which only a
 * browser resolves, so the distance between the digits and the unit is measured here.
 */

import { expect, test } from '@playwright/test';
import { fixtureRoute } from './overlay-fixture.ts';

for (const testId of ['number-input-unit', 'number-input-unit-fixed'] as const) {
  test(`the unit follows the digits (${testId})`, async ({ page }) => {
    await page.goto(fixtureRoute('number-input'), { waitUntil: 'load' });
    const host = page.getByTestId(testId);
    const input = host.locator('.cinder-number-input__input');
    const adornment = host.locator('.cinder-number-input__adornment');
    await expect(input).toBeVisible();
    await expect(adornment).toBeVisible();

    const gap = await host.evaluate((element) => {
      const field = element.querySelector<HTMLInputElement>('.cinder-number-input__input');
      const unit = element.querySelector<HTMLElement>('.cinder-number-input__adornment');
      if (field === null || unit === null) throw new Error('The field or its unit is missing.');
      // Where the unit's text starts, less where the text area ends: both read in one pass.
      const range = document.createRange();
      range.selectNodeContents(unit);
      return range.getBoundingClientRect().left - field.getBoundingClientRect().right;
    });
    // The text area ends a few characters after the digits (its minimum is 4ch), and the unit
    // starts beside it: never a field's width away.
    expect(gap).toBeGreaterThanOrEqual(-1);
    expect(gap).toBeLessThanOrEqual(16);

    const width = await input.evaluate((element) => element.getBoundingClientRect().width);
    expect(width).toBeLessThanOrEqual(80);
  });
}
