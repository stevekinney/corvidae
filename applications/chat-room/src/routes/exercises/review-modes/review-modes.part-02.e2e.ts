import { expect, test } from '@playwright/test';
import type { Page } from './review-modes-test-helpers';
import {
  announcements,
  clearSelection,
  currentSelection,
  frame,
  openReviewModes,
  openThreadPopover,
  popoverEverAppeared,
  recordAnnouncements,
  selectText,
  stopWatchingPopovers,
  surface,
  watchForPopover,
} from './review-modes-test-helpers';

test.describe('review-modes: currentUserId has three states, not two', () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await openReviewModes(page, ['modes-edit', 'modes-nouser', 'modes-emptyuser']);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('an omitted currentUserId blocks the selection popover; an empty-string one does not', async () => {
    // `showSelectionPopover` tests `currentUserId !== undefined`. That single
    // check is the entire difference between these two instances.
    const nouserPopover = page.locator('#modes-nouser-selection-popover');
    const emptyuserPopover = page.locator('#modes-emptyuser-selection-popover');

    // Same recording-before-the-gesture shape as the readonly test, and needed
    // for the same reason: the control gesture replaces this instance's
    // selection, so the end-of-test count alone could not tell "never appeared"
    // from "appeared and was torn down".
    await watchForPopover(page, 'modes-nouser-selection-popover');

    expect(await selectText(page, 'modes-nouser', 'dashboard')).toBe('dashboard');
    expect(await currentSelection(page)).toBe('dashboard');

    // `modes-emptyuser` is the control, and therefore the clock — same reasoning
    // as the readonly test, and worth noting that this instance is a sharper
    // control than the edit one would be: it differs from `modes-nouser` in the
    // single prop under test and in nothing else, so the popover appearing here
    // and not there isolates `currentUserId !== undefined` exactly.
    //
    // Note also that the gate is entirely in the derived. Unlike the readonly
    // case, the debounced handler runs to completion for `modes-nouser` and
    // writes a real `selectionPopoverPosition`; only `showSelectionPopover`
    // declines to render it.
    await clearSelection(page);
    expect(await selectText(page, 'modes-emptyuser', 'dashboard')).toBe('dashboard');
    await expect(emptyuserPopover).toHaveCount(1);

    expect(await popoverEverAppeared(page, 'modes-nouser-selection-popover')).toBe(false);
    await expect(nouserPopover).toHaveCount(0);

    await clearSelection(page);
    await expect(emptyuserPopover).toHaveCount(0);
    await stopWatchingPopovers(page);
  });

  test('an omitted currentUserId renders `Delete thread` disabled and drops the reply composer', async () => {
    const popover = page.locator('#modes-nouser-thread-popover');
    await openThreadPopover(page, 'modes-nouser');

    // Three different gates, three different outcomes, in one popover.
    // `Delete thread` renders because the instance is not readonly, and is
    // DISABLED because `disabled={!currentUserId}`…
    await expect(popover.getByRole('button', { name: 'Delete thread' })).toBeDisabled();
    // …the reply composer is gated on `!isReadonly && currentUserId`, so it
    // is not rendered at all…
    await expect(page.locator('#modes-nouser-thread-popover-composer')).toHaveCount(0);
    // …and Edit/Delete comment are absent for a reason that is neither:
    // authorship. The seeded comment's `authorId` is `steve` while
    // `currentUserId` is undefined, so `comment.authorId === currentUserId`
    // fails. From outside this looks identical to the readonly case, which
    // is why the readonly test uses a matching author to tell them apart.
    await expect(popover.getByRole('button', { name: 'Edit comment' })).toHaveCount(0);
    await expect(popover.getByRole('button', { name: 'Delete comment' })).toHaveCount(0);

    await popover.getByRole('button', { name: 'Close' }).click();
    await expect(popover).toHaveCount(0);
  });

  test('the sidebar still offers `Add document comment` without a user — it accepts a body, closes, and fires nothing', async () => {
    // The sidebar button is gated on `!readonly` alone; the identity check
    // happens later, inside `handleAddDocumentComment`, which `devWarn`s and
    // returns. The affordance is therefore fully interactive and completely
    // inert — indistinguishable from a working one without the event log.
    await surface(frame(page, 'modes-nouser'))
      .getByRole('button', { name: 'Open comments sidebar (1 comment)' })
      .click();
    await page
      .locator('#modes-nouser-sidebar')
      .getByRole('button', { name: 'Add document comment' })
      .click();

    const composer = page.locator('#modes-nouser-sidebar-document-composer');
    await expect(composer).toHaveAttribute(
      'placeholder',
      'Add a comment about the entire document...',
    );
    await composer.fill('Anonymous document note');
    // The composer submits on Cmd/Ctrl+Enter; its inline submit button only
    // becomes clickable on `:focus-within`, so the keyboard path is both the
    // documented one and the stable one.
    await page.keyboard.press('Control+Enter');

    // It closes on submit exactly as a successful one would.
    await expect(composer).toHaveCount(0);
    await expect(page.getByTestId('modes-nouser-threadcreate-count')).toHaveText('threadcreate: 0');
    await expect(page.getByTestId('modes-nouser-event-count')).toHaveText('events: 0');
    await expect(page.locator('#modes-nouser-sidebar .thread-item')).toHaveCount(1);

    // Control: the identical flow with `currentUserId="steve"` fires once,
    // carrying the body and the author on the event.
    await surface(frame(page, 'modes-edit'))
      .getByRole('button', { name: 'Open comments sidebar (1 comment)' })
      .click();
    await page
      .locator('#modes-edit-sidebar')
      .getByRole('button', { name: 'Add document comment' })
      .click();
    await page.locator('#modes-edit-sidebar-document-composer').fill('Real document note');
    await page.keyboard.press('Control+Enter');

    await expect(page.getByTestId('modes-edit-threadcreate-count')).toHaveText('threadcreate: 1');
    await expect(page.getByTestId('modes-edit-event-log').getByRole('listitem')).toHaveText([
      'threadcreate:steve:Real document note',
    ]);
    // The thread list is still 1: `onthreadcreate` is notification-only and
    // this page deliberately never applies it.
    await expect(page.locator('#modes-edit-sidebar .thread-item')).toHaveCount(1);
  });

  test('currentUserId="" offers the whole comment-creation flow and then refuses the submit, announcing it assertively', async () => {
    const scope = surface(frame(page, 'modes-emptyuser'));
    await recordAnnouncements(scope);

    const popover = page.locator('#modes-emptyuser-selection-popover');
    expect(await selectText(page, 'modes-emptyuser', 'dashboard')).toBe('dashboard');
    await expect(popover).toHaveCount(1);

    await popover.getByLabel('Add comment').click();
    await popover.getByLabel('Comment text').fill('Should not be accepted');
    await popover.getByLabel('Submit comment').click();

    // `handleSelectionComment` opens with `if (!currentUserId)` — a
    // TRUTHINESS test, where the visibility gate was `!== undefined`. The
    // empty string passes one and fails the other, so the flow is offered in
    // full and dropped at the last step.
    //
    // Asserting the COMPOSER is gone, not the popover. `toHaveCount(0)` on the
    // popover was pinning a transient: the refusal calls `clear()`, which drops
    // the position and the expanded flag — but `clear()` is not a close-latch,
    // and visibility is derived from a live selection that still has 'dashboard'
    // in it, so the 20ms `selectionchange` debounce re-mounts the popover in its
    // collapsed icon state. Per-frame sampling found the absent window is only
    // ~16-27ms wide in every engine (chromium 24-40ms, webkit 50-69ms, firefox
    // 63-80ms); Chromium happened to sample inside it and the other two did not.
    //
    // So this is a Chromium-specific assumption being corrected, not a WebKit
    // bug — and the replacement pins strictly more than the original did. The
    // durable, engine-independent claim is that the composer was dismissed and
    // the typed body discarded, while the affordance itself remains offered.
    await expect(popover.getByLabel('Comment text')).toHaveCount(0);
    await expect(popover.getByRole('button', { name: 'Add comment' })).toHaveCount(1);
    await expect(page.getByTestId('modes-emptyuser-threadcreate-count')).toHaveText(
      'threadcreate: 0',
    );
    await expect(page.getByTestId('modes-emptyuser-event-count')).toHaveText('events: 0');

    // The failure is announced on the assertive region — `role="alert"`,
    // `aria-live="assertive"` — and that region is `cinder-sr-only`, so the
    // text is NOT visible on the page. `review-ssr-and-a11y` owns the
    // geometry; here only the message and its priority matter.
    const alert = scope.locator('[role="alert"][aria-live="assertive"]');
    await expect(alert).toHaveClass(/cinder-sr-only/);
    await expect
      .poll(() => announcements(page))
      .toContain('Could not add comment. Please try selecting text again.');
  });
});
