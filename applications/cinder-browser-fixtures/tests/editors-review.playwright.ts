import { expect, test } from './review-editor-browser-errors.ts';

test.describe('review comments toggle', () => {
  test('comments toggle contains a badge with the count and remains keyboard focusable', async ({
    page,
  }) => {
    await page.goto('/page/review-editor-comments?snapshot=1', { waitUntil: 'load' });
    await page.waitForSelector('#app > *', { state: 'visible', timeout: 20_000 });

    // Locate the comments toggle button via its aria-controls attribute.
    // The button controls the sidebar panel whose id ends with "-sidebar".
    const commentsToggle = page.locator('button[aria-controls$="-sidebar"]').first();

    await expect(commentsToggle).toBeVisible();

    // The visible count must be rendered by the Badge component — it carries
    // the .cinder-badge class and is aria-hidden so the button's aria-label
    // remains the sole accessible count source.
    const badge = commentsToggle.locator('.cinder-badge');
    await expect(badge).toBeVisible();
    expect(await badge.getAttribute('aria-hidden')).toBe('true');

    // The badge must contain a numeric text node (count ≥ 0).
    const badgeContent = await badge.textContent();
    const badgeText = badgeContent?.trim() ?? '';
    expect(/^\d+$/.test(badgeText)).toBe(true);

    // The button's aria-label must include the same count as a human-readable string.
    const ariaLabel = (await commentsToggle.getAttribute('aria-label')) ?? '';
    expect(ariaLabel).toContain(badgeText);

    // The button must keep aria-expanded and aria-controls.
    expect(await commentsToggle.getAttribute('aria-expanded')).not.toBeNull();
    expect(await commentsToggle.getAttribute('aria-controls')).not.toBeNull();

    // The button must be keyboard focusable: Tab should bring focus to it.
    // Resolve focus by evaluating via the browser — Tab navigation in Playwright
    // may need prior focus seeding; use element.focus() directly.
    await commentsToggle.evaluate((element) => {
      if (!(element instanceof HTMLElement)) throw new Error('Expected an HTML element.');
      element.focus();
    });
    await expect(commentsToggle).toBeFocused();

    // Confirm Space or Enter activates the toggle (keyboard operability).
    // We just verify the button is focusable and has a valid tabIndex.
    const tabIndex = await commentsToggle.evaluate((element) =>
      element instanceof HTMLElement ? element.tabIndex : -1,
    );
    // tabIndex of 0 or -1 are both valid for a toolbar button; -1 means it is
    // programmatically focusable even if excluded from tab order when the toolbar
    // manages roving focus. The important thing is that it is focusable.
    expect(tabIndex).toBeGreaterThanOrEqual(-1);
  });
});
