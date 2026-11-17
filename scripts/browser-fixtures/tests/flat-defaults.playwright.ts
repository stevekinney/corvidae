/// <reference lib="dom" />
/**
 * COR-2449 (AC3): a surface inside a surface is flat by default, and its `framed` opt-in draws the
 * frame. Each pair is drawn by the component's own fixture (DescriptionList `fields`, a Collapsible
 * nested in a Collapsible's open panel, a Table inside a Card), so the screenshot shows the default
 * beside the opt-in, and the measurement here holds that the default draws no frame and the opt-in
 * does. happy-dom resolves no cascade, so it is measured in a browser.
 */

import { expect, test } from '@playwright/test';
import { fixtureRoute } from './overlay-fixture.ts';

const FRAME = ['border-top-width', 'border-top-style'] as const;

test.describe('flat by default, framed on request', () => {
  test('DescriptionList fields draws no tinted frame by default, and the framed one does', async ({
    page,
  }) => {
    await page.goto(fixtureRoute('description-list'), { waitUntil: 'load' });
    const flat = page.getByTestId('description-list-fields-flat').locator('dl');
    const framed = page.getByTestId('description-list-fields-framed').locator('dl');
    await expect(flat).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(framed).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(flat).toHaveCSS('border-top-width', '0px');
  });

  test('a Collapsible in an open Collapsible panel is flat by default, and the framed one keeps its card', async ({
    page,
  }) => {
    await page.goto(fixtureRoute('collapsible'), { waitUntil: 'load' });
    const inner = (testId: string) =>
      page.getByTestId(testId).locator('.cinder-collapsible__panel .cinder-collapsible').first();
    await expect(inner('collapsible-nested-flat')).toBeVisible();
    await expect(inner('collapsible-nested-flat')).toHaveCSS('border-top-width', '0px');
    await expect(inner('collapsible-nested-framed')).toBeVisible();
    await expect(inner('collapsible-nested-framed')).not.toHaveCSS('border-top-width', '0px');
    // The outer disclosure keeps its own frame in both: nesting changes only the inner one.
    await expect(
      page.getByTestId('collapsible-nested-flat').locator('.cinder-collapsible').first(),
    ).not.toHaveCSS('border-top-width', '0px');
  });

  test('a Table in a Card draws no frame of its own by default, and the framed one does', async ({
    page,
  }) => {
    await page.goto(fixtureRoute('table'), { waitUntil: 'load' });
    const flat = page.getByTestId('table-in-card-flat').locator('table.cinder-table');
    const framed = page.getByTestId('table-in-card-framed').locator('table.cinder-table');
    for (const property of FRAME) {
      await expect(framed).not.toHaveCSS(property, property.endsWith('width') ? '0px' : 'none');
    }
    await expect(flat).toHaveCSS('border-top-width', '0px');
  });
});
