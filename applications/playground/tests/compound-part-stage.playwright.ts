/**
 * A compound part's Playground stage is decided once, not raced.
 *
 * A part that can mount alone (DropdownSeparator, DropdownGroup) used to render the composed-guidance
 * stage first and swap it for the live preview when its lazily imported module resolved. The
 * production gate then failed whenever that import landed between its composed-stage check and
 * the assertion on the parent link. Such a part must reserve the live stage from the start and
 * never show composed guidance; a part that cannot mount alone keeps its composed guidance.
 */
import { expect, test, type Page } from '@playwright/test';

const BARE_MOUNTABLE_PARTS = ['dropdown-separator', 'dropdown-group'] as const;
const COMPOSED_ONLY_PART = { name: 'dropdown-item', parent: 'dropdown' } as const;

const COMPOSED_SEEN = '__compoundPartComposedStageSeen';

test.beforeAll(async ({ request }) => {
  // Render each document once up front, so the test measures the stage, not the first render.
  for (const name of [...BARE_MOUNTABLE_PARTS, COMPOSED_ONLY_PART.name]) {
    await request.get(`/page/${name}`);
  }
});

async function openHydratedPage(page: Page, name: string): Promise<void> {
  await page.goto(`/page/${name}`);
  await page.locator('[data-component-page][data-page-hydrated]').waitFor({ state: 'attached' });
}

/** Record whether the composed stage is ever in the document from now on. */
async function watchForComposedStage(page: Page): Promise<void> {
  await page.evaluate((flag) => {
    const record = (): void => {
      if (document.querySelector('[data-stage-composed]') !== null) {
        (window as unknown as Record<string, boolean>)[flag] = true;
      }
    };
    (window as unknown as Record<string, boolean>)[flag] = false;
    new MutationObserver(record).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
    });
    record();
  }, COMPOSED_SEEN);
}

for (const name of BARE_MOUNTABLE_PARTS) {
  test(`${name} reserves its live stage and never shows composed guidance`, async ({ page }) => {
    await openHydratedPage(page, name);
    await watchForComposedStage(page);

    await page.locator('#view-tab-playground').click();
    const panel = page.locator('#view-panel-playground');
    await expect(
      panel.locator('.dx-stage__canvas > .example-preview[data-example-preview-ready]').first(),
    ).toBeAttached();

    expect(
      await page.evaluate(
        (flag) => (window as unknown as Record<string, boolean>)[flag],
        COMPOSED_SEEN,
      ),
    ).toBe(false);
  });
}

test(`${COMPOSED_ONLY_PART.name} cannot mount alone and keeps its composed guidance`, async ({
  page,
}) => {
  await openHydratedPage(page, COMPOSED_ONLY_PART.name);
  await page.locator('#view-tab-playground').click();

  const composed = page.locator('#view-panel-playground [data-stage-composed]');
  await expect(composed.locator(`a[href="/page/${COMPOSED_ONLY_PART.parent}"]`)).toBeVisible();
});
