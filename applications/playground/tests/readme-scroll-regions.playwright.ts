/**
 * README content scrolls only through focusable regions, and never widens the page.
 *
 * Code blocks: `.cinder-code-block__viewport` is the keyboard-focusable scroll region. The
 * documentation prose rule gave every README `<pre>` `overflow-x: auto`, so a plaintext line wider
 * than a phone made the inner `<pre>` a second scroll region that keyboard users could not reach
 * (axe `scrollable-region-focusable` on Run Step Timeline at 390px).
 *
 * Tables: a rendered Markdown table is as wide as its widest cell, so the landing README's
 * workspace table widened the whole page at 390px. Each table now scrolls in its own focusable
 * region (`src/readme-tables.ts`).
 */
import { expect, test } from '@playwright/test';

test.use({ viewport: { width: 390, height: 844 } });

test('README code blocks have no unfocusable scroll region at phone width', async ({ page }) => {
  await page.goto('/page/run-step-timeline');
  await page.locator('[data-readme-code-block]').first().waitFor();

  const unfocusableScrollRegions = await page.evaluate(() =>
    [...document.querySelectorAll('[data-readme-code-block] *')]
      .filter((element) => {
        const overflow = getComputedStyle(element).overflowX;
        return (
          (overflow === 'auto' || overflow === 'scroll') &&
          element.scrollWidth > element.clientWidth &&
          !(element instanceof HTMLElement && element.tabIndex >= 0)
        );
      })
      .map((element) => element.outerHTML.slice(0, 80)),
  );

  expect(unfocusableScrollRegions).toEqual([]);
  await expect(page.locator('[data-readme-code-block] pre').first()).toBeAttached();
});

test('the landing README fits a phone and its tables scroll in a focusable region', async ({
  page,
}) => {
  await page.goto('/');
  await page.locator('.readme-content table').first().waitFor();

  const layout = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
    unwrappedTables: [...document.querySelectorAll('.readme-content table')].filter(
      (table) => table.parentElement?.closest('.readme-table-scroll[tabindex="0"]') === null,
    ).length,
  }));

  expect(layout.unwrappedTables).toBe(0);
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
});

test('inline code in README prose wraps instead of widening the page', async ({ page }) => {
  // Review Editor's README lists API names such as `exportAggregateReviewJson()`, which made the
  // documentation 523px wide at 390px before inline code could wrap.
  await page.goto('/page/review-editor');
  await page.locator('.readme-content code').first().waitFor();

  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => document.documentElement.clientWidth),
  );
});
