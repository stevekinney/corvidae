import { expect, test } from '@playwright/test';
import {
  CREATION_PARAGRAPH,
  SELECTION_DEBOUNCE_WINDOW_MS,
  expectSelectionPopoverGone,
  loggedPayload,
  ready,
  selectCreationParagraph,
  submitSelectionComment,
} from './review-comment-creation-test-helpers';

test.describe('review-comment-creation: creation is notification-only', () => {
  test('submitting fires exactly one onthreadcreate and changes nothing else', async ({ page }) => {
    await ready(page);
    await selectCreationParagraph(page);
    await submitSelectionComment(page, 'Can we ship this in the first release instead?');

    // Exactly one callback, not one per keystroke and not one per selection.
    await expect(page.getByTestId('event-entry')).toHaveCount(1);
    const payload = await loggedPayload(page);

    expect(payload.authorId).toBe('steve');
    expect(payload.body).toBe('Can we ship this in the first release instead?');

    // `requestId` exists to correlate an optimistic insert with a server
    // response — it is NOT the thread id, and the host still has to mint one.
    // `generateId()` uses `crypto.randomUUID()` whenever it is available, which
    // it is on localhost (a secure context), so the shape is a real UUID rather
    // than the timestamp fallback.
    expect(payload.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    // The anchor quotes exactly what was dragged over.
    expect(payload.anchor?.quote).toBe(CREATION_PARAGRAPH);
    expect(payload.anchor?.originalQuote).toBe(CREATION_PARAGRAPH);
    expect(payload.anchor?.status).toBe('anchored');
    // `prefix` is the preceding paragraph plus the block separator; there is
    // nothing after the last paragraph, so `suffix` is empty.
    expect(payload.anchor?.prefix).toContain('The dashboard ships in the first release.');
    expect(payload.anchor?.suffix).toBe('');

    // And now the point of the route: the callback fired, and the bindable
    // `threads` array is untouched. The page's own readout still says zero, the
    // comments toggle still counts zero, and no decoration was drawn. Asserted
    // AFTER the event is known to have been logged, so it cannot pass vacuously
    // by running before anything happened.
    await expect(page.getByTestId('thread-count')).toHaveText('threads: 0');
    await expect(
      page.getByTestId('creation-host').getByRole('button', { name: /comments sidebar/ }),
    ).toHaveAccessibleName('Open comments sidebar (0 comments)');
    await expect(page.locator('#creation-editor .comment-anchor')).toHaveCount(0);
  });

  test('the anchor a UI-created thread ships has no `type` at all — not `text`', async ({
    page,
  }) => {
    await ready(page);
    await selectCreationParagraph(page);
    await submitSelectionComment(page, 'Typed?');

    await expect(page.getByTestId('event-entry')).toHaveCount(1);

    // `buildAnchorFromSelection` never sets `type`. `isTextAnchor` treats
    // `undefined` as text for backwards compatibility, so the component itself
    // copes — but any consumer that branches on `anchor.type === 'text'`
    // misclassifies every thread its own UI created. The readout distinguishes
    // "absent" from "present and undefined", which `JSON.stringify` cannot.
    await expect(page.getByTestId('last-anchor-type')).toHaveText('last anchor.type: (absent)');
    const payload = await loggedPayload(page);
    expect(payload.anchor).toBeDefined();
    expect(Object.keys(payload.anchor!)).not.toContain('type');
  });

  test('submitting closes the composer and hands focus back to the editor', async ({ page }) => {
    await ready(page);
    // The popover's absence below is a negative assertion about a debounced
    // timer, so the timer is driven rather than waited on: with the clock
    // installed, `runFor` advances past the editor's selection debounce
    // deterministically instead of sleeping for a multiple of it.
    await page.clock.install();
    await selectCreationParagraph(page);

    const popover = page.locator('#creation-editor-selection-popover');
    const editor = page.locator('#creation-editor .ProseMirror');

    await popover.getByRole('button', { name: 'Add comment' }).click();
    await popover.getByRole('textbox', { name: 'Comment text' }).fill('First thought.');
    // Cmd/Ctrl+Enter, the composer's own submit shortcut — nothing else in this file
    // exercises it on the SELECTION popover, and the comment below needs it.
    await page.keyboard.press('ControlOrMeta+Enter');

    // What holds after every submit, on every run: the event fired once with the
    // typed body, the composer is gone, and the editor has the focus back.
    await expect(page.getByTestId('event-entry')).toHaveCount(1);
    const payload = await loggedPayload(page);
    expect(payload.body).toBe('First thought.');
    await expect(editor).toBeFocused();
    // Deleted for the same reason as its twin in the Escape test above: the
    // composer's return would require `selectionPopoverExpanded` to go true
    // again, which only a click on "Add comment" can do
    // (review-editor-impl.svelte:1294, reached solely from `onExpand` at :1884).
    // These two are about the composer and the expanded attribute specifically;
    // the collapsed popover's own fate is the block below.
    await expect(popover.getByRole('textbox', { name: 'Comment text' })).toHaveCount(0);
    await expect(
      page.locator('#creation-editor-selection-popover[data-cinder-expanded]'),
    ).toHaveCount(0);

    // The popover must NOT come back over the text just commented on. ProseMirror
    // restores its stored, still non-collapsed selection into the DOM when the
    // editor regains focus, and that `selectionchange` used to re-open the
    // popover (~6 clicked submits in 10; the keyboard path usually lands
    // collapsed instead). Whether the restore happens is timing the test cannot
    // pin, so put the exact commented range back into the DOM by hand — the
    // same `selectionchange` the restore produces — give the editor's 20ms
    // selection debounce five times its window, and assert the popover stayed
    // away. `consumedSelection` in review-editor-impl.svelte is what holds it
    // back (CIN-515).
    const reselectParagraph = () =>
      page.evaluate(() => {
        const paragraph = document.querySelectorAll('#creation-editor .ProseMirror p')[1]!;
        const range = document.createRange();
        range.selectNodeContents(paragraph);
        const selection = document.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
      });
    await reselectParagraph();
    await expect.poll(() => page.evaluate(() => document.getSelection()?.isCollapsed)).toBe(false);
    await page.clock.runFor(SELECTION_DEBOUNCE_WINDOW_MS);
    await expect(page.locator('#creation-editor-selection-popover')).toHaveCount(0);

    // A keystroke that leaves the selection where it is does not release the
    // hold — the release is driven by where the editor's selection SETTLES,
    // not by the key that was pressed. (Releasing on the keystroke would
    // reintroduce the original race: a caret key inside ProseMirror's focus
    // window collapses the DOM selection, the pending restore puts the old
    // range back, and the popover would reopen.)
    await page.keyboard.press('ControlOrMeta+c');
    await page.keyboard.press('Shift');
    await reselectParagraph();
    await page.clock.runFor(SELECTION_DEBOUNCE_WINDOW_MS);
    await expect(page.locator('#creation-editor-selection-popover')).toHaveCount(0);

    // Select-all releases the hold outright, without waiting for the selection
    // to settle elsewhere: a comment covering the whole document would leave
    // a keyboard-only user unable to comment on it again, and the browser may
    // emit no `selectionchange` at all when everything is already selected.
    // The event is dispatched rather than typed for exactly that reason —
    // this pins the release on the keystroke, not on a range that changed.
    await page.evaluate(() => {
      document
        .querySelector('#creation-editor .ProseMirror')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
    });
    await reselectParagraph();
    await page.clock.runFor(SELECTION_DEBOUNCE_WINDOW_MS);
    await expect(page.locator('#creation-editor-selection-popover')).toHaveCount(1);

    // The hold is not permanent. A pointer press lands a caret of its own
    // first, so whatever it selects next is the user's — including the very
    // same paragraph, which is what a double-click on just-commented text
    // does, and which must offer to comment on it again.
    await editor.click();
    await reselectParagraph();
    await page.clock.runFor(SELECTION_DEBOUNCE_WINDOW_MS);
    await expect(page.locator('#creation-editor-selection-popover')).toHaveCount(1);
  });
});

test.describe('review-comment-creation: applying the events', () => {
  test('the page-owned addThread reducer is what actually makes the thread appear', async ({
    page,
  }) => {
    await ready(page);
    await page.getByTestId('apply-events').check();

    await selectCreationParagraph(page);
    await submitSelectionComment(page, 'Ship this earlier.');

    // Same event as the previous group; the only difference is that the page
    // now feeds it through `addThread` from `@repo/editor/comments`.
    await expect(page.getByTestId('thread-count')).toHaveText('threads: 1');
    await expect(page.getByTestId('comment-count')).toHaveText('comments: 1');

    // The decoration lands on exactly the quoted range — one span, the
    // paragraph's text, and nothing else. Count alone would pass even if the
    // span covered the whole document, so both are asserted.
    const anchors = page.locator('#creation-editor .comment-anchor');
    await expect(anchors).toHaveCount(1);
    await expect(anchors.first()).toHaveText(CREATION_PARAGRAPH);

    // The toggle's count comes from the component's own view of `threads`, so it
    // moves too.
    const creationHost = page.getByTestId('creation-host');
    const commentsToggle = creationHost.getByRole('button', { name: /comments sidebar/ });
    await expect(commentsToggle).toHaveAccessibleName('Open comments sidebar (1 comment)');

    // And the sidebar lists it, quote and body.
    await expectSelectionPopoverGone(page);
    await commentsToggle.click();
    const sidebar = page.locator('#creation-editor-sidebar');
    await expect(sidebar).toBeVisible();
    await expect(sidebar.locator('.thread-quote')).toHaveText(CREATION_PARAGRAPH);
    await expect(sidebar.locator('.thread-preview')).toHaveText('Ship this earlier.');
  });

  test('replying inside a thread fires oncommentcreate, and addComment appends it', async ({
    page,
  }) => {
    await ready(page);
    await page.getByTestId('apply-events').check();
    await selectCreationParagraph(page);
    await submitSelectionComment(page, 'Ship this earlier.');
    await expect(page.locator('#creation-editor .comment-anchor')).toHaveCount(1);
    await expectSelectionPopoverGone(page);

    // Clicking an anchor decoration opens the thread popover for that thread.
    await page.locator('#creation-editor .comment-anchor').click();
    const threadPopover = page.locator('#creation-editor-thread-popover');
    await expect(threadPopover).toBeVisible();

    // The reply composer's placeholder reads "Reply...", but its ACCESSIBLE NAME
    // is "Comment" — it comes from the sr-only <label>, which is identical in
    // every CommentComposer. The submit Button's text is also "Comment", so
    // role is the only thing separating the two.
    const composer = threadPopover.getByRole('textbox', { name: 'Comment' });
    await expect(composer).toHaveAttribute('placeholder', 'Reply...');
    // `exact` is load-bearing now. Each rendered comment carries its own "Edit
    // comment" and "Delete comment" action buttons, and the default substring,
    // case-insensitive name match sweeps both of those up alongside the submit
    // button — three elements, and a strict-mode violation. The assertion is
    // unchanged; only the locator got precise enough to name one button.
    await expect(threadPopover.getByRole('button', { name: 'Comment', exact: true })).toBeVisible();

    await composer.fill('Agreed — @maya can you confirm?');
    await page.keyboard.press('ControlOrMeta+Enter');

    // Cmd/Ctrl+Enter submits, the textarea clears, and focus stays put so the
    // next reply can be typed immediately.
    await expect(composer).toHaveValue('');
    await expect(composer).toBeFocused();

    await expect(page.getByTestId('comment-count')).toHaveText('comments: 2');
    const reply = await loggedPayload(page, 1);
    expect(reply.body).toBe('Agreed — @maya can you confirm?');
    expect(reply.mentions).toEqual(['maya']);
    expect(reply.authorId).toBe('steve');
    // The reply event carries the thread it belongs to; `addComment` needs it.
    expect(typeof reply.threadId).toBe('string');
  });
});
