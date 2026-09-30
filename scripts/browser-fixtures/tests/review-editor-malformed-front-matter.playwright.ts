import { expect, test } from '@playwright/test';
import { reviewEditorRoute } from './review-editor-accessibility-route.ts';

const malformed = '---\nowner: [\n---\n\n# Malformed\n';
const warning = 'Front matter could not be parsed; showing as plain text.';

/**
 * COR-865: `ReviewEditor`'s malformed-front-matter recovery (COR-651), exercised in a real
 * browser. The unit suites cover the logic under happy-dom; this covers the rendered notice, the
 * polite live region, real focus placement, and byte-for-byte document preservation.
 */
test.describe('ReviewEditor malformed front matter recovery', () => {
  test.beforeEach(async ({ page }) => {
    // The live region clears its message on a timer, so record every non-empty polite text as it
    // appears instead of racing the clear.
    await page.addInitScript(() => {
      const announcements: string[] = [];
      (window as unknown as { __announcements: string[] }).__announcements = announcements;
      const seen = new WeakMap<Element, string>();
      const scan = () => {
        for (const region of document.querySelectorAll('[aria-live="polite"]')) {
          const text = region.textContent ?? '';
          if (text !== '' && seen.get(region) !== text) announcements.push(text);
          seen.set(region, text);
        }
      };
      new MutationObserver(scan).observe(document, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
    });
    await page.goto(reviewEditorRoute('review-editor-malformed-front-matter'), {
      waitUntil: 'load',
    });
    await page.waitForSelector('#example-mount-malformed-front-matter', {
      state: 'visible',
      timeout: 20_000,
    });
  });

  test('announces, focuses the opening fence, and dismisses without touching the document', async ({
    page,
  }) => {
    const mount = page.locator('#example-mount-malformed-front-matter');
    const editor = mount.locator('#malformed-front-matter-editor');
    const note = mount.getByRole('note', { name: 'Front matter warning' });
    const exported = mount.locator('#malformed-front-matter-export');
    const boundValue = mount.locator('#malformed-front-matter-value');

    // Checked first, from the recorded history: announced exactly once, politely.
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { __announcements: string[] }).__announcements),
      )
      .toEqual([warning]);

    // The malformed block is ordinary editable text, not a structured front-matter form.
    await expect(editor).toBeVisible();
    await expect(editor).toHaveValue(malformed);
    await expect(editor).toBeEditable();

    await expect(note).toBeVisible();
    await expect(note).toContainText(warning);
    await expect(mount.locator('[aria-live="assertive"], [role="alert"]')).toHaveCount(0);

    await expect(editor).not.toBeFocused();
    await mount.getByRole('button', { name: 'Edit as plain text' }).click();
    await expect(editor).toBeFocused();
    expect(
      await editor.evaluate((element: HTMLTextAreaElement) => [
        element.selectionStart,
        element.selectionEnd,
      ]),
    ).toEqual([0, 0]);

    await mount.getByRole('button', { name: 'Dismiss front matter warning' }).click();
    await expect(note).toHaveCount(0);

    await mount.getByRole('button', { name: 'Read Markdown export' }).click();
    // `toHaveText` normalizes whitespace, so compare the raw text exactly.
    await expect.poll(() => exported.textContent()).toBe(malformed);
    expect(await boundValue.textContent()).toBe(malformed);
    await expect(editor).toHaveValue(malformed);
  });
});
