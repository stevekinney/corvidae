import { expect, test } from '@playwright/test';
import {
  CREATION_PARAGRAPH,
  dragSelect,
  expectSelectionPopoverGone,
  loggedPayload,
  ready,
  selectCreationParagraph,
  submitSelectionComment,
} from './review-comment-creation-test-helpers';

test.describe('review-comment-creation: document-level comments', () => {
  test('the sidebar composes a document comment whose anchor is anchored to nothing', async ({
    page,
  }) => {
    await ready(page);
    await page.getByTestId('apply-events').check();

    const creationHost = page.getByTestId('creation-host');
    await creationHost.getByRole('button', { name: /comments sidebar/ }).click();
    const sidebar = page.locator('#creation-editor-sidebar');
    await expect(sidebar).toBeVisible();

    // With nothing to show, the sidebar advertises both routes into creation —
    // the selection one and this button.
    await expect(sidebar.locator('.empty-state')).toContainText('No comments yet');
    await expect(sidebar.locator('.empty-state')).toContainText(
      'Select text or click + to add a comment',
    );

    // The button is a toggle: its accessible name flips while composing, which
    // is the only signal that the second press cancels rather than submits.
    const addDocumentComment = sidebar.getByRole('button', { name: 'Add document comment' });
    await addDocumentComment.click();
    await expect(sidebar.getByRole('button', { name: 'Cancel document comment' })).toBeVisible();

    const composer = sidebar.getByRole('textbox', { name: 'Comment' });
    // The composer's id is derived from the sidebar's id, which is itself
    // derived from the editor's — three levels of id concatenation.
    await expect(composer).toHaveAttribute('id', 'creation-editor-sidebar-document-composer');
    await composer.fill('Overall this reads well.');
    await page.keyboard.press('ControlOrMeta+Enter');

    await expect(page.getByTestId('event-entry')).toHaveCount(1);
    const payload = await loggedPayload(page);

    // `createDocumentAnchor()` produces a deliberately empty anchor: this is the
    // one place `anchor.type` IS set, and the positions are zeroed because there
    // is nothing to point at.
    expect(payload.anchor).toEqual({
      type: 'document',
      quote: '',
      prefix: '',
      suffix: '',
      from: 0,
      to: 0,
      status: 'anchored',
    });
    await expect(page.getByTestId('last-anchor-type')).toHaveText('last anchor.type: document');

    // Applied, it sorts ahead of text threads and renders no decoration at all —
    // `from === to === 0` is an empty range, and the decoration pass skips those.
    await expect(page.getByTestId('thread-count')).toHaveText('threads: 1');
    const item = sidebar.locator('button.thread-item');
    await expect(item).toHaveCount(1);
    await expect(item).toHaveAttribute('data-document', 'true');
    await expect(item.locator('.thread-document-label')).toHaveText('Document comment');
    await expect(page.locator('#creation-editor .comment-anchor')).toHaveCount(0);
  });

  test('a document thread sorts ahead of a text thread in the sidebar', async ({ page }) => {
    await ready(page);
    await page.getByTestId('apply-events').check();

    // Text thread first, so ordering cannot be an artifact of insertion order.
    await selectCreationParagraph(page);
    await submitSelectionComment(page, 'Text-anchored note.');
    await expect(page.getByTestId('thread-count')).toHaveText('threads: 1');
    await expectSelectionPopoverGone(page);

    const creationHost = page.getByTestId('creation-host');
    await creationHost.getByRole('button', { name: /comments sidebar/ }).click();
    const sidebar = page.locator('#creation-editor-sidebar');
    await sidebar.getByRole('button', { name: 'Add document comment' }).click();
    await sidebar.getByRole('textbox', { name: 'Comment' }).fill('Document-level note.');
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(page.getByTestId('thread-count')).toHaveText('threads: 2');

    const items = sidebar.locator('button.thread-item');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toHaveAttribute('data-document', 'true');
    await expect(items.nth(0).locator('.thread-preview')).toHaveText('Document-level note.');
    await expect(items.nth(1)).not.toHaveAttribute('data-document');
    await expect(items.nth(1).locator('.thread-quote')).toHaveText(CREATION_PARAGRAPH);
  });
});

test.describe('review-comment-creation: the composer', () => {
  test('refuses whitespace, hides its submit until focus-within, and cancels on Escape', async ({
    page,
  }) => {
    await ready(page);

    const creationHost = page.getByTestId('creation-host');
    await creationHost.getByRole('button', { name: /comments sidebar/ }).click();
    const sidebar = page.locator('#creation-editor-sidebar');
    await sidebar.getByRole('button', { name: 'Add document comment' }).click();

    const form = sidebar.locator('form.comment-composer');
    const composer = form.getByRole('textbox', { name: 'Comment' });
    const inlineSubmit = form.locator('.comment-composer-inline-submit');

    // The submit button is painted invisible and click-through until something
    // inside the form has focus. A cold click on it — before touching the
    // textarea — cannot land, which is a genuine trap for a test that reaches
    // for the button first. Asserted as computed style rather than by attempting
    // a click that is designed to time out.
    await expect(inlineSubmit).toHaveCSS('opacity', '0');
    await expect(inlineSubmit).toHaveCSS('pointer-events', 'none');

    await composer.click();
    await expect(inlineSubmit).toHaveCSS('opacity', '1');
    await expect(inlineSubmit).toHaveCSS('pointer-events', 'auto');

    // Whitespace is not a comment: the button disables and the keyboard path
    // refuses too. A successful submit clears the textarea AND closes the
    // document composer, so "still mounted, still holding the spaces" is
    // positive evidence that nothing went through — not just an absence.
    await composer.fill('   ');
    await expect(form.getByRole('button', { name: 'Comment' })).toBeDisabled();
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(composer).toHaveValue('   ');
    await expect(page.getByTestId('event-entry')).toHaveCount(0);

    // Escape cancels composition entirely — the composer unmounts, the toggle
    // flips back, and nothing is emitted.
    await page.keyboard.press('Escape');
    await expect(composer).toHaveCount(0);
    await expect(sidebar.getByRole('button', { name: 'Add document comment' })).toBeVisible();
    await expect(page.getByTestId('event-entry')).toHaveCount(0);
  });
});

test.describe('review-comment-creation: mentions', () => {
  test('extractMentions dedupes, allows - and _, and skips emails and inline code', async ({
    page,
  }) => {
    await ready(page);
    await page.getByTestId('apply-events').check();
    await selectCreationParagraph(page);
    await submitSelectionComment(
      page,
      'hi @alice, @bob-2 and @alice again; mail x@y.com; `@code`; @a_b',
    );

    await expect(page.getByTestId('event-entry')).toHaveCount(1);
    const payload = await loggedPayload(page);

    // Order is insertion order through a Set: first sighting wins, the repeat of
    // @alice is dropped, `x@y.com` is not a mention because the `@` is preceded
    // by a word character, and the inline-code span is stripped before matching.
    expect(payload.mentions).toEqual(['alice', 'bob-2', 'a_b']);

    // The body is stored verbatim. There is no linkification and no mention
    // autocomplete anywhere in the package — `mentions` is metadata for the
    // host to act on, not a rendering feature.
    await expectSelectionPopoverGone(page);
    const anchor = page.locator('#creation-editor .comment-anchor');
    await expect(anchor).toHaveCount(1);
    await anchor.click();
    const threadPopover = page.locator('#creation-editor-thread-popover');
    await expect(threadPopover.locator('.comment-body')).toHaveText(
      'hi @alice, @bob-2 and @alice again; mail x@y.com; `@code`; @a_b',
    );
    await expect(threadPopover.locator('.comment-body a')).toHaveCount(0);
  });

  test('a body with no mentions omits the field entirely rather than sending []', async ({
    page,
  }) => {
    await ready(page);
    await selectCreationParagraph(page);
    await submitSelectionComment(page, 'No one to ping here.');

    await expect(page.getByTestId('event-entry')).toHaveCount(1);
    // `mentions: mentions.length > 0 ? mentions : undefined` — so a host that
    // does `event.mentions.length` crashes on the common case. The readout
    // distinguishes an absent field from an empty array; JSON alone cannot.
    await expect(page.getByTestId('last-mentions')).toHaveText('last mentions: (absent)');
    const payload = await loggedPayload(page);
    expect(Object.keys(payload)).not.toContain('mentions');
  });
});

test.describe('review-comment-creation: the anchor collision', () => {
  test('dragging inside already-commented text opens the thread popover, not the selection popover', async ({
    page,
  }) => {
    await ready(page);

    // The second instance seeds one thread on the word "dashboard", so there is
    // a real decoration to drag across.
    const anchor = page.locator('#creation-collision .comment-anchor');
    await expect(anchor).toHaveCount(1);
    await expect(anchor).toHaveText('dashboard');

    // Settle on the paragraph (its center is past the end of the text, so the
    // caret lands harmlessly at the line end and no popover opens), then drag
    // across the middle of the anchor itself. Staying well inside the span is
    // what makes this deterministic: the browser dispatches `click` on the
    // nearest common ancestor of mousedown and mouseup, so a drag that spills
    // over either edge reports the paragraph instead and the collision does not
    // happen at all.
    const paragraph = page.locator('#creation-collision .ProseMirror p').first();
    await dragSelect(page, paragraph, anchor, 0.25, 0.75);

    // PINNED DEFECT, not desired behavior. The anchor plugin's `click` handler
    // fires on that mouseup, sets the popover thread, and `showSelectionPopover`
    // is derived with `popoverThreadId === null` in it — so the selection
    // popover can never appear. Commenting on already-commented text with a
    // mouse is therefore impossible: the drag that would start a new thread is
    // always read as a click on the old one.
    const threadPopover = page.locator('#creation-collision-thread-popover');
    await expect(threadPopover).toBeVisible();
    await expect(page.locator('#creation-collision-selection-popover')).toHaveCount(0);

    // It is the seeded thread that opened, and its focus trap has already taken
    // the keyboard — so even a keyboard user cannot get back to the selection.
    await expect(threadPopover).toHaveAttribute('role', 'dialog');
    await expect(threadPopover).toContainText('dashboard');
    await expect(threadPopover.getByRole('button', { name: 'Delete thread' })).toBeFocused();

    // A plain click on the anchor does the same thing, which is the intended
    // gesture — the collision is that a drag is indistinguishable from it.
    await page.keyboard.press('Escape');
    await expect(threadPopover).toHaveCount(0);
    await anchor.click();
    await expect(page.locator('#creation-collision-thread-popover')).toBeVisible();
  });
});
