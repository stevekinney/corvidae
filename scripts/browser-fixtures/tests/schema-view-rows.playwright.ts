/// <reference lib="dom" />
/**
 * SchemaView (owner review, 2026-11-13: too dark, not clearly a schema, dividers that stop short).
 * The view takes the fill a Card has on the same page, with no darker header band; each row leads
 * with its label and a type mark of its kind; and nothing in a row is a vertical line,
 * so a row whose description wraps has nothing left short. happy-dom performs no layout, so this
 * is measured in a browser on the `anatomy` fixture, in both themes, at 1280 and 390.
 */

import { THEME_STORAGE_KEY } from '@lostgradient/testing';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { fixtureRoute } from './overlay-fixture.ts';

const TOLERANCE = 0.5;

async function openAnatomy(
  browser: Browser,
  theme: 'light' | 'dark',
  width: number,
): Promise<Page> {
  const context = await browser.newContext({
    colorScheme: theme,
    reducedMotion: 'reduce',
    viewport: { width, height: 1200 },
  });
  await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [
    THEME_STORAGE_KEY,
    theme,
  ] as const);
  const page = await context.newPage();
  await page.goto(fixtureRoute('schema-view', { fixtureName: 'anatomy' }), { waitUntil: 'load' });
  await page.locator('.cinder-schema-view__row').first().waitFor();
  return page;
}

for (const theme of ['light', 'dark'] as const) {
  for (const width of [1280, 390]) {
    test.describe(`SchemaView rows, ${theme} at ${width}`, () => {
      let page: Page;

      test.beforeAll(async ({ browser }) => {
        page = await openAnatomy(browser, theme, width);
      });

      test.afterAll(async () => {
        await page.context().close();
      });

      test('the sheet has the fill a Card has, with no darker header band', async () => {
        const fills = await page.evaluate(() => {
          const probe = document.createElement('div');
          probe.style.background = 'var(--cinder-surface-raised)';
          document.body.append(probe);
          const card = getComputedStyle(probe).backgroundColor;
          probe.remove();
          const read = (selector: string) => {
            const element = document.querySelector(selector);
            if (!element) throw new Error(`${selector} is missing.`);
            return getComputedStyle(element).backgroundColor;
          };
          return {
            card,
            frame: read('.cinder-schema-view__frame'),
            header: read('.cinder-schema-view__row--header'),
          };
        });
        expect(fills.frame).toBe(fills.card);
        expect(fills.header).toBe('rgba(0, 0, 0, 0)');
      });

      test('no row draws a vertical line, and every divider spans the whole row', async () => {
        const rows = await page.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>('.cinder-schema-view__row')].map((row) => {
            const box = row.getBoundingClientRect();
            const vertical: string[] = [];
            for (const element of [row, ...row.querySelectorAll<HTMLElement>('*')]) {
              const style = getComputedStyle(element);
              if (
                Number.parseFloat(style.borderInlineStartWidth) > 0 ||
                Number.parseFloat(style.borderInlineEndWidth) > 0
              ) {
                vertical.push(element.className);
              }
              for (const pseudo of ['::before', '::after']) {
                const part = getComputedStyle(element, pseudo);
                if (part.content !== 'none' && part.position === 'absolute') {
                  vertical.push(`${element.className}${pseudo}`);
                }
              }
            }
            const frame = row.closest('.cinder-schema-view__frame')?.getBoundingClientRect();
            return {
              vertical,
              left: box.left,
              right: box.right,
              frameLeft: (frame?.left ?? 0) + 1,
              frameRight: (frame?.right ?? 0) - 1,
            };
          }),
        );
        expect(rows.length).toBeGreaterThan(8);
        for (const row of rows) {
          expect(row.vertical).toEqual([]);
          expect(Math.abs(row.left - row.frameLeft)).toBeLessThanOrEqual(TOLERANCE);
          expect(Math.abs(row.right - row.frameRight)).toBeLessThanOrEqual(TOLERANCE);
        }
      });

      test('a row leads with its label, its type mark beside it', async () => {
        const first = page
          .locator('.cinder-schema-view__row:not(.cinder-schema-view__row--header)')
          .first();
        await expect(first.locator('.cinder-schema-view__label')).toHaveText('Repository');
        await expect(first.locator('.cinder-schema-view__type')).toHaveText('text');
        const geometry = await first.evaluate((row) => {
          const box = (selector: string) => {
            const element = row.querySelector(selector);
            if (!element) throw new Error(`${selector} is missing.`);
            return element.getBoundingClientRect();
          };
          return {
            label: box('.cinder-schema-view__label'),
            type: box('.cinder-schema-view__type'),
            description: box('.cinder-schema-view__description'),
          };
        });
        // Name and type share the first line; at 390 the description sits under them.
        expect(
          Math.abs(
            geometry.label.top +
              geometry.label.height / 2 -
              (geometry.type.top + geometry.type.height / 2),
          ),
        ).toBeLessThanOrEqual(3);
        expect(geometry.type.left).toBeGreaterThan(geometry.label.right);
        if (width === 390) {
          expect(geometry.description.top).toBeGreaterThanOrEqual(geometry.type.bottom - TOLERANCE);
        } else {
          expect(geometry.description.left).toBeGreaterThan(geometry.type.right);
        }
      });
    });
  }
}
