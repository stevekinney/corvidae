/// <reference lib="dom" />
/**
 * COR-2449 (AC3): a surface inside a surface is flat by default, and its `framed` opt-in draws the
 * frame. Each pair is drawn by the component's own fixture (DescriptionList `fields`, a Collapsible
 * nested in a Collapsible's open panel, a Table inside a Card), so the screenshot shows the default
 * beside the opt-in, and the measurement here holds that the default draws no frame and the opt-in
 * does. happy-dom resolves no cascade, so it is measured in a browser.
 */

import { fixtureRoute } from '@lostgradient/testing/playwright/overlay-fixture';
import { expect, test } from '@playwright/test';

const FRAME = ['border-top-width', 'border-top-style'] as const;

test.describe('flat by default, framed on request', () => {
  test('DescriptionList fields draws no tinted frame by default, and the framed one does', async ({
    page,
  }) => {
    await page.goto(fixtureRoute('description-list'), { waitUntil: 'load' });
    const flat = page.getByTestId('description-list-fields-flat').locator('dl');
    const framed = page.getByTestId('description-list-fields-framed').locator('dl');
    // A framed group paints its fill on the list's `::before` (COR-2394), so both are read there.
    const fill = async (list: typeof flat) =>
      list.evaluate((element) => ({
        own: getComputedStyle(element).backgroundColor,
        layer: getComputedStyle(element, '::before').backgroundColor,
      }));
    const [flatFill, framedFill] = await Promise.all([fill(flat), fill(framed)]);
    expect(flatFill).toEqual({ own: 'rgba(0, 0, 0, 0)', layer: 'rgba(0, 0, 0, 0)' });
    expect(framedFill.layer).not.toBe('rgba(0, 0, 0, 0)');
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
    // The scroll box owns a Table's frame when it has one; a Table without one draws its own.
    const frameOf = (testId: string) =>
      page.getByTestId(testId).locator('.cinder-table-scroll, table.cinder-table').first();
    const flat = frameOf('table-in-card-flat');
    const framed = frameOf('table-in-card-framed');
    for (const property of FRAME) {
      await expect(framed).not.toHaveCSS(property, property.endsWith('width') ? '0px' : 'none');
    }
    await expect(flat).toHaveCSS('border-top-width', '0px');
  });
});

test.describe('flat Collapsible touch reach', () => {
  test.use({ hasTouch: true, isMobile: true });

  for (const width of [320, 375]) {
    test(`the flat Collapsible reaches 44px without covering its panel control at ${String(width)}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(fixtureRoute('collapsible'), { waitUntil: 'load' });
      const trigger = page
        .getByTestId('collapsible-nested-flat')
        .getByRole('button', { name: 'Tracking events', exact: true });
      await trigger.scrollIntoViewIfNeeded();
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');

      await trigger.evaluate((button) => {
        const panel = document.getElementById(button.getAttribute('aria-controls') ?? '');
        const panelContent = panel?.firstElementChild;
        if (panelContent === null || panelContent === undefined) {
          throw new Error('The Collapsible trigger must name its panel.');
        }
        const control = document.createElement('button');
        control.type = 'button';
        control.textContent = 'Inside tracking';
        control.addEventListener('click', () => {
          control.textContent = 'Tracking activated';
        });
        panelContent.prepend(control);
      });

      const adjacent = page.getByRole('button', { name: 'Inside tracking' });
      await adjacent.tap();
      await expect(page.getByRole('button', { name: 'Tracking activated' })).toBeVisible();
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');

      const measured = await trigger.evaluate((button) => {
        const bounds = button.getBoundingClientRect();
        const x = bounds.x + bounds.width / 2;
        const centreY = bounds.y + bounds.height / 2;
        const top = centreY - 21.5;
        const bottom = centreY + 21.5;
        return {
          coarse: window.matchMedia('(any-pointer: coarse)').matches,
          drawnHeight: bounds.height,
          x,
          top,
          bottom,
          edgesReachTrigger: [top, bottom].map((y) =>
            button.contains(document.elementFromPoint(x, y)),
          ),
        };
      });
      expect(measured.coarse).toBe(true);
      expect(measured.drawnHeight).toBeLessThan(44);
      expect(measured.edgesReachTrigger).toEqual([true, true]);
      await page.touchscreen.tap(measured.x, measured.top);
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      await page.touchscreen.tap(measured.x, measured.bottom);
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    });
  }
});
