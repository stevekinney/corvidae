/**
 * Every page header's controls at the inline end share the centre line of its title's first line
 * (COR-2438): Cinder's PageHeader centres its actions and an inline status in a line box of the
 * title's own size, so no control sits above or below the title whatever its height. Checked on the
 * pages that draw a PageHeader with actions, at 1280 and 1920 pixels.
 */
import type { Page } from '@playwright/test';

import { expect, test } from './fixtures.ts';

const PAGES = ['/agents', '/workflows', '/runs', '/reviews', '/schedules'] as const;

/** The centre of the title's first line box and of every control among the header's actions. */
async function centres(page: Page) {
  return page.evaluate(() => {
    const header = document.querySelector('.cinder-page-header:not([data-cinder-variant="hero"])');
    const title = header?.querySelector('.cinder-page-header__title');
    if (header === null || header === undefined || title === null || title === undefined) {
      return undefined;
    }
    const range = document.createRange();
    range.selectNodeContents(title);
    const first = [...range.getClientRects()].find((rect) => rect.height > 0);
    if (first === undefined) return undefined;
    const controls = [
      ...header.querySelectorAll<HTMLElement>(
        '.cinder-page-header__row > .cinder-page-header__actions :is(button, a[href])',
      ),
    ].filter((control) => control.getBoundingClientRect().height > 0);
    const status = header.querySelector(
      '.cinder-page-header__status[data-cinder-placement="inline"]',
    );
    return {
      title: first.top + first.height / 2,
      controls: controls.map((control) => {
        const box = control.getBoundingClientRect();
        return {
          name: control.getAttribute('aria-label') ?? control.textContent?.trim() ?? '',
          centre: box.top + box.height / 2,
        };
      }),
      status:
        status === null
          ? undefined
          : (() => {
              const box = status.getBoundingClientRect();
              return box.top + box.height / 2;
            })(),
    };
  });
}

for (const width of [1280, 1920]) {
  for (const path of PAGES) {
    test(`centres the header controls on the title's first line on ${path}, at ${width} pixels`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(path);
      await expect(page.locator('.cinder-page-header__title').first()).toBeVisible();
      const measured = await centres(page);
      expect(measured, `${path} draws a PageHeader`).toBeDefined();
      for (const control of measured!.controls) {
        expect(
          Math.abs(control.centre - measured!.title),
          `${path}: ${control.name} at ${control.centre}, title line at ${measured!.title}`,
        ).toBeLessThanOrEqual(2);
      }
      if (measured!.status !== undefined) {
        expect(Math.abs(measured!.status - measured!.title)).toBeLessThanOrEqual(2);
      }
    });
  }
}
