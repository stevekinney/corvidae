import { expect, test } from '@playwright/test';
import {
  ready,
  selectCreationParagraph,
  submitSelectionComment,
} from './review-comment-creation-test-helpers';

test.describe('review-comment-creation: announcements', () => {
  test('creating a comment announces through a visually hidden live region', async ({ page }) => {
    await ready(page);

    // The region wipes itself one second after announcing (so a repeated message
    // re-announces), which makes "read the text off the DOM afterwards" a race
    // this test would lose under load. Record mutations instead, then assert on
    // what was recorded.
    await page.evaluate(() => {
      const seen: string[] = [];
      Reflect.set(window, '__announced', seen);
      for (const region of document.querySelectorAll('[role="status"][aria-live="polite"]')) {
        new MutationObserver(() => {
          const text = region.textContent?.trim();
          if (text) seen.push(text);
        }).observe(region, { childList: true, characterData: true, subtree: true });
      }
    });

    await selectCreationParagraph(page);
    await submitSelectionComment(page, 'Announce me.');

    await expect
      .poll(() =>
        page.evaluate(() => {
          const announced = Reflect.get(window, '__announced');
          return Array.isArray(announced) && announced.every((entry) => typeof entry === 'string')
            ? announced
            : [];
        }),
      )
      .toContain('Comment added');

    // And it is for screen readers only. The region used to render as visible
    // page text (the component reached for a bare `sr-only` class that Cinder
    // does not ship); every polite region is now clipped to a pixel. Measured
    // rather than asserted by class name, so this pins the outcome, not the fix.
    const widths = await page
      .locator('[role="status"][aria-live="polite"]')
      .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().width));
    expect(widths.length).toBeGreaterThan(0);
    expect(Math.max(...widths)).toBeLessThanOrEqual(2);
  });
});
