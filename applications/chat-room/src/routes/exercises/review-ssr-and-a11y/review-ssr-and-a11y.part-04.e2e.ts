import { expect, test } from '@playwright/test';
import {
  EDITOR_ID,
  activeDescriptor,
  announcements,
  openSidebar,
  openThreadPopover,
  ready,
  recordAnnouncements,
} from './review-ssr-and-a11y-test-helpers';

test.describe('review-ssr-and-a11y: the thread popover', () => {
  test('the popover is non-modal, and aria-modal no longer claims otherwise', async ({ page }) => {
    await ready(page);
    await openThreadPopover(page);

    const popover = page.locator('.thread-popover');
    await expect(popover).toHaveAttribute('role', 'dialog');

    // FIXED, cinder#1305. `aria-modal="true"` is a promise to assistive tech
    // that everything outside the dialog is unavailable, and nothing backed
    // it: neither the editor region nor the comment sidebar was ever `inert`
    // or `aria-hidden` while the popover was open, and F6 landmark
    // navigation (pinned by 'F6 alternates between the editor and an open
    // popover' below) has always been able to move focus out regardless —
    // deliberately, since this popover is non-modal by design. The fix
    // removes the attribute rather than trying to earn it: it does not make
    // the popover modal, it stops the popover claiming to be.
    await expect(popover).not.toHaveAttribute('aria-modal');

    // Still true, and now consistent with what the popover actually claims:
    // nothing outside it is inert or hidden.
    const outside = await page.evaluate(() => {
      const main = document.querySelector('.review-editor-main');
      const sidebar = document.querySelector('aside.comment-sidebar');
      return {
        mainInert: main?.hasAttribute('inert') ?? null,
        mainHidden: main?.getAttribute('aria-hidden') ?? null,
        sidebarInert: sidebar?.hasAttribute('inert') ?? null,
        sidebarHidden: sidebar?.getAttribute('aria-hidden') ?? null,
      };
    });
    expect(outside).toEqual({
      mainInert: false,
      mainHidden: null,
      sidebarInert: false,
      sidebarHidden: null,
    });
  });

  test('Escape closes the popover and restores focus to the sidebar item that opened it', async ({
    page,
  }) => {
    await ready(page);
    await openSidebar(page);

    // Opened by KEYBOARD rather than through the shared click helper, and that
    // is the whole point of the test rather than a detail. Restoration works by
    // snapshotting `document.activeElement` at activation — so it can only
    // restore to the sidebar item if that item had focus when the popover
    // opened. A click gives it focus in Chromium and Firefox but NOT in WebKit,
    // which does not focus a button on mousedown, so the click path was
    // quietly testing a precondition that only two engines provide.
    //
    // Focusing and pressing Enter is both the engine-independent path and the
    // one a keyboard user actually takes — which is the user this test is about.
    await page.locator('button.thread-item').focus();
    await expect
      .poll(() => activeDescriptor(page))
      .toMatchObject({ tag: 'BUTTON', className: expect.stringContaining('thread-item') });
    await page.keyboard.press('Enter');

    await expect(page.locator('.thread-popover')).toBeVisible();
    await expect.poll(() => activeDescriptor(page)).toMatchObject({ label: 'Delete thread' });

    await page.keyboard.press('Escape');
    await expect(page.locator('.thread-popover')).toHaveCount(0);

    // Back to the item that opened it.
    await expect
      .poll(() => activeDescriptor(page))
      .toMatchObject({ tag: 'BUTTON', className: expect.stringContaining('thread-item') });
  });

  test('replying through the popover announces the new comment', async ({ page }) => {
    await ready(page);
    await openThreadPopover(page);
    await recordAnnouncements(page);

    await page.locator(`#${EDITOR_ID}-thread-popover-composer`).fill('A reply from steve');
    await page
      .locator('.thread-popover')
      .getByRole('button', { name: 'Comment', exact: true })
      .click();

    await expect.poll(() => announcements(page)).toContain('Comment added');
    await expect(page.getByTestId('event-log')).toContainText('commentcreate:thread-a11y-title');
  });
});

test.describe('review-ssr-and-a11y: F6 landmark navigation', () => {
  test('F6 does nothing in the default state', async ({ page }) => {
    await ready(page);

    // A paragraph, not the surface's centre: clicking the anchored-comment
    // decoration would open the thread popover and activate the second region.
    await page
      .locator(`#${EDITOR_ID} .ProseMirror`)
      .getByText('The first release includes')
      .click();
    await expect.poll(() => activeDescriptor(page)).toMatchObject({ role: 'textbox' });

    // The component registers exactly two regions — the editor and the thread
    // popover — and marks the popover inactive unless one is open. With a
    // single active region, "next region" resolves back to the editor and the
    // custom focus handler re-focuses the ProseMirror view: F6 and Shift+F6
    // are both no-ops.
    //
    // The utility's own documentation shows a three-region example including a
    // `sidebar` region, and ReviewEditor never registers one — so the comment
    // sidebar is unreachable by F6 in either state.
    await page.keyboard.press('F6');
    await expect.poll(() => activeDescriptor(page)).toMatchObject({ role: 'textbox' });

    await page.keyboard.press('Shift+F6');
    await expect.poll(() => activeDescriptor(page)).toMatchObject({ role: 'textbox' });
  });

  test('F6 alternates between the editor and an open popover', async ({ page }) => {
    await ready(page);
    // The helper waits for the popover's focus trap to settle. Without that
    // wait, the `.focus()` below would race the trap's deferred initial focus
    // and be quietly undone a microtask later.
    await openThreadPopover(page);

    // Focus is moved back to the editor PROGRAMMATICALLY rather than by
    // clicking: the popover closes on any click outside itself, so a click
    // into the document would destroy the very state under test.
    await page.evaluate((editorId) => {
      const surface = document.querySelector(`#${editorId} .ProseMirror`);
      if (surface instanceof HTMLElement) surface.focus();
    }, EDITOR_ID);
    await expect.poll(() => activeDescriptor(page)).toMatchObject({ role: 'textbox' });

    // Two active regions now, so F6 crosses into the popover's first focusable
    // element and Shift+F6 crosses back. Note the sidebar is skipped in both
    // directions even though it is open and full of controls.
    await page.keyboard.press('F6');
    await expect
      .poll(() => activeDescriptor(page))
      .toMatchObject({ label: 'Delete thread', inPopover: true });

    await page.keyboard.press('Shift+F6');
    await expect.poll(() => activeDescriptor(page)).toMatchObject({ role: 'textbox' });

    await page.keyboard.press('F6');
    await expect
      .poll(() => activeDescriptor(page))
      .toMatchObject({ label: 'Delete thread', inPopover: true });
  });
});
