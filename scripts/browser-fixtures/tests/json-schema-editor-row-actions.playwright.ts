import { expect, test } from '@playwright/test';
import { fixtureRoute } from './layout-fixture.ts';

// COR-2432, row 65s: a fields table's row keeps its own actions inside its box, and the table never
// scrolls sideways. `#example-mount-fields` is the builder's 720px form column with a long
// description, which must wrap rather than push Delete past the column (768 and 1280);
// `#example-mount-fields-narrow` is a 350px column, where the actions sit in one icon menu. On a
// 320px phone both are narrow, and a field's name is never broken inside a word.

const CASES = [
  { width: 320, mounts: ['#example-mount-fields', '#example-mount-fields-narrow'] },
  { width: 768, mounts: ['#example-mount-fields', '#example-mount-fields-narrow'] },
  { width: 1280, mounts: ['#example-mount-fields', '#example-mount-fields-narrow'] },
] as const;

for (const { width, mounts } of CASES) {
  test(`every row action of the fields table is inside its row at ${String(width)}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(fixtureRoute('json-schema-editor'), { waitUntil: 'load' });
    for (const mount of mounts) {
      // Every box is read in one evaluate, so the comparisons come from one layout.
      const measured = await page.locator(mount).evaluate((root) => {
        const visible = (element: Element): boolean => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };
        const table = root.querySelector('.cinder-jse-property-table');
        const scroller = table?.parentElement;
        const rootBox = root.getBoundingClientRect();
        return {
          sideways:
            scroller === null || scroller === undefined
              ? 0
              : scroller.scrollWidth - scroller.clientWidth,
          tableRight: table?.getBoundingClientRect().right ?? 0,
          rootRight: rootBox.right,
          // A name drawn on more than one line box was broken inside the word.
          brokenNames: [...root.querySelectorAll('.cinder-jse-property-row__name')]
            .filter((name) => name.getClientRects().length > 1)
            .map((name) => name.textContent),
          rows: [...root.querySelectorAll<HTMLElement>('.cinder-jse-property-row')].map((row) => {
            const box = row.getBoundingClientRect();
            const controls = [
              ...row.querySelectorAll<HTMLElement>(
                '.cinder-jse-property-row__required input, .cinder-jse-property-row__actions button',
              ),
            ].filter(visible);
            return {
              left: box.left,
              right: box.right,
              controls: controls.map((control) => {
                const rect = control.getBoundingClientRect();
                return {
                  name: control.getAttribute('aria-label') ?? control.textContent ?? '',
                  left: rect.left,
                  right: rect.right,
                };
              }),
            };
          }),
        };
      });
      expect(measured.rows.length, `${mount} rows`).toBeGreaterThan(0);
      expect(measured.sideways, `${mount} scrolls sideways`).toBeLessThanOrEqual(0);
      expect(measured.tableRight, `${mount} table right edge`).toBeLessThanOrEqual(
        measured.rootRight + 1,
      );
      expect(measured.brokenNames, `${mount} names broken inside a word`).toEqual([]);
      for (const row of measured.rows) {
        // The checkbox and at least one action control are drawn.
        expect(row.controls.length, `${mount} controls`).toBeGreaterThanOrEqual(2);
        for (const control of row.controls) {
          expect(control.left, `${mount} ${control.name} left`).toBeGreaterThanOrEqual(
            row.left - 1,
          );
          expect(control.right, `${mount} ${control.name} right`).toBeLessThanOrEqual(
            Math.min(row.right, measured.rootRight) + 1,
          );
        }
      }
    }
  });
}
