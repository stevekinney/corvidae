/**
 * README code blocks scroll through one focusable viewport.
 *
 * `.cinder-code-block__viewport` is the keyboard-focusable scroll region. The documentation
 * prose rule gave every README `<pre>` `overflow-x: auto`, so a plaintext line wider than a phone
 * made the inner `<pre>` a second scroll region that keyboard users could not reach (axe
 * `scrollable-region-focusable` on Run Step Timeline at 390px).
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
