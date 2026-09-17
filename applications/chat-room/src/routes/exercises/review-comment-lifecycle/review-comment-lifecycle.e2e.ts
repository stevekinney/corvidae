import { expect, test } from '@playwright/test';
import {
  FULL_QUOTE,
  POPOVER_TITLE_30,
  ROUTE,
  SIDEBAR_PREVIEW_80,
  SIDEBAR_QUOTE_60,
  commentsToggle,
  defined,
  docRow,
  gotoHydrated,
  openSidebar,
  payloadsFor,
  popover,
  rowQuoted,
  selectThread,
  sidebar,
  threadRows,
} from './review-comment-lifecycle-test-helpers';

test.describe('review comment lifecycle: the sidebar', () => {
  test.beforeEach(async ({ page }) => {
    await gotoHydrated(page, ROUTE);
  });
  test('the sidebar has no `open` prop — it exists only once the toolbar toggle is clicked', async ({
    page,
  }) => {
    // Not "hidden": absent. There is no way to render the ReviewEditor with
    // its comment sidebar already open, which means `aria-controls` on the
    // toggle points at an element that does not exist yet.
    await expect(sidebar(page)).toHaveCount(0);
    await expect(commentsToggle(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(commentsToggle(page)).toHaveAttribute('aria-controls', 'lifecycle-editor-sidebar');
    await openSidebar(page);
    // `aria-controls` resolving is the fix from cinder PR #1266: the controls
    // bar is instantiated as `{editorId}-controls`, so deriving the sidebar id
    // from its own id used to produce `lifecycle-editor-controls-sidebar`.
    await expect(sidebar(page)).toHaveAttribute('aria-label', 'Comment threads');
    await expect(commentsToggle(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(sidebar(page).locator('.sidebar-header h2.sidebar-title')).toHaveText('Comments');
  });
  test('threads sort document-first, then by anchor.from, and the all-deleted ghost is omitted', async ({
    page,
  }) => {
    await openSidebar(page);
    // Four threads are seeded; `t-empty` has no visible comment, so the
    // sidebar drops it entirely. The count badge counts what it renders.
    await expect(page.getByTestId('thread-count')).toHaveText('threads: 4');
    await expect(threadRows(page)).toHaveCount(3);
    await expect(sidebar(page).locator('.thread-count')).toHaveText('3');
    // Document threads come first regardless of position; text threads follow
    // in ascending `anchor.from` order (1, then 91).
    await expect(sidebar(page).locator('button.thread-item[data-document="true"]')).toHaveCount(1);
    await expect(threadRows(page).nth(0)).toHaveAttribute('data-document', 'true');
    await expect(threadRows(page).nth(0).locator('.thread-document-label')).toHaveText(
      'Document comment',
    );
    await expect(threadRows(page).nth(0).locator('blockquote.thread-quote')).toHaveCount(0);
    await expect(threadRows(page).nth(1).locator('blockquote.thread-quote')).toHaveText(
      'Release Plan',
    );
    await expect(threadRows(page).nth(2).locator('blockquote.thread-quote')).toHaveText(
      SIDEBAR_QUOTE_60,
    );
    // The ghost's quote is nowhere in the list even though its anchor is still
    // decorating the document.
    await expect(sidebar(page)).not.toContainText('Timeline risk');
  });
  test('the preview is the first VISIBLE comment, truncated at 80', async ({ page }) => {
    await openSidebar(page);
    await expect(threadRows(page).nth(2).locator('p.thread-preview')).toHaveText(
      SIDEBAR_PREVIEW_80,
    );
    // `t-text`'s first comment is by `steve`; soft-deleting it promotes the
    // NEXT visible comment into the preview rather than blanking the row.
    const textRow = rowQuoted(page, 'Release Plan');
    await expect(textRow.locator('p.thread-preview')).toHaveText(
      'Should this say "Launch Plan" instead?',
    );
    const dialog = await selectThread(page, textRow);
    await dialog
      .locator('article.comment[data-comment-id="c-text-steve"]')
      .getByRole('button', { name: 'Delete comment' })
      .click();
    await expect(textRow.locator('p.thread-preview')).toHaveText(
      'Marketing signed off on "Release Plan" last week.',
    );
  });
});
test.describe('review comment lifecycle: the thread popover', () => {
  test.beforeEach(async ({ page }) => {
    await gotoHydrated(page, ROUTE);
    await openSidebar(page);
  });
  test('selecting a thread marks exactly one row active and opens a non-modal dialog inside the container', async ({
    page,
  }) => {
    const dialog = await selectThread(page, rowQuoted(page, 'Release Plan'));
    await expect(rowQuoted(page, 'Release Plan')).toHaveAttribute('data-active', 'true');
    await expect(rowQuoted(page, 'Release Plan')).toHaveAttribute('aria-current', 'true');
    // Exactly one at a time — selection is not additive.
    await expect(sidebar(page).locator('[data-active]')).toHaveCount(1);
    await expect(sidebar(page).locator('[aria-current="true"]')).toHaveCount(1);
    await expect(dialog).toHaveAttribute('role', 'dialog');
    // cinder#1305 removed `aria-modal` entirely rather than setting it
    // `"false"`: this is a deliberately non-modal, anchored dialog — the same
    // pattern as a comment popover in Google Docs or a GitHub PR review
    // thread — and `aria-modal="true"` was a promise the component never
    // kept. F6 landmark navigation moves focus out to `.review-editor-main`
    // while this popover stays open, and nothing here makes the rest of the
    // editor `inert`, so an unbacked `aria-modal="true"` was actively wrong
    // rather than merely redundant.
    await expect(dialog).not.toHaveAttribute('aria-modal');
    await expect(dialog).toHaveAttribute(
      'aria-labelledby',
      'lifecycle-editor-thread-popover-title',
    );
    // NOT portaled — unlike the selection popover, which cinder does portal to
    // `document.body`. This one is a child of the review-editor container, so
    // it inherits the container's stacking context and CSS scope.
    //
    // That container is NOT `#lifecycle-editor`, which is what this used to
    // assert and what never held: the `id` prop lands on the markdown
    // editor's own content div, buried inside `.review-editor-main >
    // .markdown-editor-layout`, and the container merely hangs the DERIVED
    // ids off it (`-controls`, `-sidebar`, `-thread-popover`) while carrying
    // no id of its own. The popover is a direct child of that unlabelled
    // `.review-editor-container`, a sibling of the subtree holding the
    // editor — so pin it by the element that contains both.
    const container = page
      .locator('div.review-editor-container')
      .filter({ has: page.locator('#lifecycle-editor') });
    await expect(container).toHaveCount(1);
    await expect(page.locator('body > #lifecycle-editor-thread-popover')).toHaveCount(0);
    await expect(container.locator('> #lifecycle-editor-thread-popover')).toHaveCount(1);
  });
  test('Escape closes the popover and clears the active row', async ({ page }) => {
    await selectThread(page, rowQuoted(page, 'Release Plan'));
    // The popover traps focus, so a bare page-level Escape lands inside it.
    await page.keyboard.press('Escape');
    await expect(popover(page)).toHaveCount(0);
    await expect(sidebar(page).locator('[data-active]')).toHaveCount(0);
    await expect(sidebar(page)).toBeVisible();
  });
  test('the title truncates the quote at 30 characters and keeps the full quote in `title`', async ({
    page,
  }) => {
    const dialog = await selectThread(page, rowQuoted(page, 'Reviewers should verify'));
    await expect(dialog.locator('.thread-popover-quote')).toHaveText(POPOVER_TITLE_30);
    // The only place the untruncated quote survives in the DOM.
    await expect(dialog.locator('.thread-popover-quote')).toHaveAttribute('title', FULL_QUOTE);
  });
  test('a document thread shows a `Document comment` label instead of a quote', async ({
    page,
  }) => {
    const dialog = await selectThread(page, docRow(page));
    await expect(dialog.locator('.thread-popover-document-label')).toHaveText('Document comment');
    await expect(dialog.locator('.thread-popover-quote')).toHaveCount(0);
  });
});
test.describe('review comment lifecycle: replying', () => {
  test.beforeEach(async ({ page }) => {
    await gotoHydrated(page, ROUTE);
    await openSidebar(page);
  });
  test('a reply fires oncommentcreate and changes nothing until the reducer applies it', async ({
    page,
  }) => {
    const dialog = await selectThread(page, rowQuoted(page, 'Release Plan'));
    // The reply composer's accessible name is `Comment` (from an sr-only
    // label) while its placeholder is `Reply...` — and the inline submit
    // Button is ALSO named `Comment`. Locate the textarea by id to sidestep
    // the collision entirely. The inline submit is `opacity: 0;
    // pointer-events: none` until `:focus-within`, so Cmd/Ctrl+Enter is the
    // reliable path: `fill` focuses first, then the shortcut submits.
    const composer = dialog.locator('#lifecycle-editor-thread-popover-composer');
    await expect(composer).toHaveAttribute('placeholder', 'Reply...');
    await composer.fill('Renaming it now would break the changelog.');
    await composer.press('ControlOrMeta+Enter');
    await expect(page.getByTestId('event-log').locator('li')).toHaveCount(1);
    const commentCreatePayloads = await payloadsFor(page, 'commentcreate');
    const created = defined(commentCreatePayloads[0], 'commentcreate payload');
    expect(created['threadId']).toBe('t-text');
    expect(created['authorId']).toBe('steve');
    expect(created['body']).toBe('Renaming it now would break the changelog.');
    expect(typeof created['requestId']).toBe('string');
    expect(created['requestId']).not.toBe('');
    // No `@` in the body, so `extractMentions` found nothing and the field is
    // omitted rather than set to an empty array.
    expect('mentions' in created).toBe(false);
    // The point of the whole route: at the moment the callback fired, the
    // bindable `threads` array was untouched. It moved only because the page's
    // reducer called `addComment` on it.
    await expect(page.getByTestId('counts-at-last-event')).toHaveText(
      'at event time: threads:4 visible:4 stored:6',
    );
    await expect(page.getByTestId('visible-comment-count')).toHaveText('visible comments: 5');
    await expect(page.getByTestId('last-changed')).toHaveText('last reducer changed: true');
    // The composer clears itself on submit and keeps focus.
    await expect(composer).toHaveValue('');
    await expect(composer).toBeFocused();
    await expect(dialog.locator('article.comment')).toHaveCount(3);
  });
});
