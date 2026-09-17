import { expect, test } from '@playwright/test';
import {
  HEADING,
  MAIN_ID,
  READONLY_ID,
  pressNextTabStop,
  ready,
} from './markdown-editor-test-helpers';

test.describe('markdown-editor: keyboard and announcements', () => {
  test('Tab moves focus out of the editing surface', async ({ page, browserName }) => {
    await ready(page);
    const focusIsInsideEditor = () =>
      page.evaluate(
        (id) => document.getElementById(id)?.contains(document.activeElement) ?? false,
        MAIN_ID,
      );

    await page.getByTestId('focus-editor').click();
    await expect.poll(focusIsInsideEditor).toBe(true);

    await pressNextTabStop(page, browserName);
    await expect.poll(focusIsInsideEditor).toBe(false);

    // What this does and does not prove, stated because the obvious reading is
    // wrong. Milkdown's keymap DOES bind Tab — to `sinkListItemCommand` — and
    // only declines the key, letting the browser move focus, when that command
    // cannot apply. This fixture has no lists, so the command always declines and
    // Tab always escapes. The Escape-then-Tab latch the same keymap carries
    // exists for the case this fixture deliberately avoids and is NOT exercised
    // here; testing it needs a document with a list, whose ProseMirror positions
    // would be parser-dependent and would break every coordinate assertion above.
  });

  test('a repeated identical announcement still re-announces', async ({ page }) => {
    await ready(page);
    // `aria-live` fires on CHANGE. `getMarkdown` announces a pure function of the
    // document, so pressing it twice with nothing edited in between produces the
    // same words — and without the clear-then-set transition the page performs,
    // Svelte writes an identical string, the DOM never changes, and a screen
    // reader hears nothing the second time. On a page whose controls all report
    // values, re-pressing to check is the obvious move.
    //
    // `toHaveText` cannot see this: it polls for a final string and stays green
    // with the transition deleted. Only counting real DOM mutations of the live
    // region can, which is what `announce-mutations` does via MutationObserver.
    const mutations = () =>
      page
        .getByTestId('announce-mutations')
        .textContent()
        .then((raw) => Number(raw ?? '0'));

    const before = await mutations();
    await page.getByTestId('read-markdown').click();
    await expect.poll(mutations).toBeGreaterThan(before);
    const afterFirst = await mutations();

    await page.getByTestId('read-markdown').click();
    await expect.poll(mutations).toBeGreaterThan(afterFirst);
    await expect(page.getByTestId('announcement')).toHaveText(/getMarkdown: \d+ characters/);
  });

  test('the page keeps one h1 after hydration, rather than one per editor', async ({ page }) => {
    await ready(page);
    // Each editor renders its document's first heading at the authored level, so a
    // `#` fixture would add an `h1` per instance — nested inside `h2` sections,
    // and invisible to SSR because the editors server-render a skeleton. The
    // fixtures use `###` for exactly this reason, and asserting it after
    // hydration is the only place the choice is observable.
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator('h1')).toHaveText('Markdown Editor');
    await expect(page.locator(`#${MAIN_ID} .ProseMirror h3`)).toHaveText(HEADING);
    await expect(page.locator(`#${READONLY_ID} .ProseMirror h3`)).toHaveText('Published Reference');
  });
});
