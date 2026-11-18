import { expect, test } from '@playwright/test';
import { fixtureRoute } from './layout-fixture.ts';

// COR-2432, row 65s: a fields table's row keeps its own actions inside its box. On a 320px phone,
// and in a 350px column of a wide page, the Required checkbox and the row's actions (the icon menu
// once the container is narrow) sit inside the row, and the table never scrolls sideways.

const CASES = [
  { width: 320, mounts: ['#example-mount-fields', '#example-mount-fields-narrow'] },
  { width: 1280, mounts: ['#example-mount-fields-narrow'] },
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
        return {
          sideways:
            scroller === null || scroller === undefined
              ? 0
              : scroller.scrollWidth - scroller.clientWidth,
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
                  name: control.getAttribute('aria-label') ?? control.textContent,
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
      for (const row of measured.rows) {
        // The checkbox and at least one action control are drawn.
        expect(row.controls.length, `${mount} controls`).toBeGreaterThanOrEqual(2);
        for (const control of row.controls) {
          expect(control.left, `${mount} ${control.name} left`).toBeGreaterThanOrEqual(
            row.left - 1,
          );
          expect(control.right, `${mount} ${control.name} right`).toBeLessThanOrEqual(
            row.right + 1,
          );
        }
      }
    }
  });
}
