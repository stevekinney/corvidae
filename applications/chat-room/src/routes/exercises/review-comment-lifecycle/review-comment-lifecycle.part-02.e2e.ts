import { expect, test } from '@playwright/test';
import {
  ROUTE,
  badge,
  defined,
  docRow,
  gotoHydrated,
  openSidebar,
  payloadsFor,
  popover,
  rowQuoted,
  selectThread,
} from './review-comment-lifecycle-test-helpers';

test.describe('review comment lifecycle: editing', () => {
  test.beforeEach(async ({ page }) => {
    await gotoHydrated(page, ROUTE);
    await openSidebar(page);
  });
  test('editing swaps the body for a prefilled textarea labelled `Edit comment`', async ({
    page,
  }) => {
    const dialog = await selectThread(page, docRow(page));
    const comment = dialog.locator('article.comment[data-comment-id="c-doc-1"]');
    await comment.getByRole('button', { name: 'Edit comment' }).click();
    // The textarea's id is derived from the COMMENT id, not the editor id, so
    // it is stable across popovers. Its label is sr-only, which is why
    // `getByLabel('Edit comment')` also matches the pencil button — locate by
    // id when you mean the field.
    const draft = dialog.locator('#c-doc-1-edit');
    await expect(draft).toHaveValue('Overall this reads well. One pass for tone and it ships.');
    await expect(dialog.locator('label[for="c-doc-1-edit"]')).toHaveText('Edit comment');
    await expect(comment.locator('.comment-body')).toHaveCount(0);
    // While a comment is being edited its action row is withdrawn entirely.
    await expect(comment.getByRole('button', { name: 'Edit comment' })).toHaveCount(0);
    // Save refuses a whitespace-only body; Cancel never does.
    await expect(
      comment.locator('.comment-edit-actions').getByRole('button', { name: 'Save' }),
    ).toBeEnabled();
    await draft.fill('   ');
    await expect(
      comment.locator('.comment-edit-actions').getByRole('button', { name: 'Save' }),
    ).toBeDisabled();
    await expect(
      comment.locator('.comment-edit-actions').getByRole('button', { name: 'Cancel' }),
    ).toBeEnabled();
  });
  test('Cmd/Ctrl+Enter saves; oncommentupdate carries no timestamp and the consumer supplies it', async ({
    page,
  }) => {
    const dialog = await selectThread(page, docRow(page));
    const comment = dialog.locator('article.comment[data-comment-id="c-doc-1"]');
    await comment.getByRole('button', { name: 'Edit comment' }).click();
    await dialog
      .locator('#c-doc-1-edit')
      .fill('Overall this reads well. Ship it after a tone pass.');
    await dialog.locator('#c-doc-1-edit').press('ControlOrMeta+Enter');
    await expect(page.getByTestId('event-log').locator('li')).toHaveCount(1);
    const commentUpdatePayloads = await payloadsFor(page, 'commentupdate');
    const updated = defined(commentUpdatePayloads[0], 'commentupdate payload');
    expect(updated).toEqual({
      threadId: 't-doc',
      commentId: 'c-doc-1',
      body: 'Overall this reads well. Ship it after a tone pass.',
    });
    // Explicitly: no `editedAt`. `updateComment` from
    // `@repo/editor/comments` REQUIRES one, so the consumer has to
    // mint it — the component has no opinion about the clock.
    expect('editedAt' in updated).toBe(false);
    await expect(comment.locator('.comment-body')).toHaveText(
      'Overall this reads well. Ship it after a tone pass.',
    );
    // `(edited)` is a consequence of the timestamp the PAGE supplied.
    await expect(comment.locator('.comment-edited')).toHaveText('(edited)');
    const editedTitle = await comment.locator('.comment-edited').getAttribute('title');
    expect(editedTitle).toMatch(/^Edited \d{4}-\d{2}-\d{2}T/);
    // Editing does not consume the actions: the comment stays editable.
    await expect(comment.getByRole('button', { name: 'Edit comment' })).toHaveCount(1);
    await expect(comment.getByRole('button', { name: 'Delete comment' })).toHaveCount(1);
  });
  test('PINNED KNOWN BUG: Escape cancels the edit AND closes the whole thread popover', async ({
    page,
  }) => {
    const dialog = await selectThread(page, docRow(page));
    const comment = dialog.locator('article.comment[data-comment-id="c-doc-1"]');
    await comment.getByRole('button', { name: 'Edit comment' }).click();
    await dialog.locator('#c-doc-1-edit').fill('Draft I intend to abandon.');
    await dialog.locator('#c-doc-1-edit').press('Escape');
    // The cancel half is correct: no `oncommentupdate` is emitted, so the draft
    // really was abandoned rather than quietly saved.
    await expect(page.getByTestId('event-log').locator('li')).toHaveCount(0);
    // The wrong half, pinned as-is because it is what the component does
    // today. `comment-list.svelte`'s Escape branch calls `cancelEdit()` and
    // then lets the event bubble — it never calls `preventDefault()` (its
    // Cmd+Enter branch does, which is exactly why SAVING keeps the popover
    // open). `thread-popover.svelte`'s keydown handler guards only on
    // `!event.defaultPrevented`, so the same keystroke closes the dialog. One
    // Escape should back out of the edit; it backs out of the thread.
    await expect(popover(page)).toHaveCount(0);
    // Reopening proves the body really was restored rather than lost with the
    // popover.
    const reopened = await selectThread(page, docRow(page));
    await expect(
      reopened.locator('article.comment[data-comment-id="c-doc-1"] .comment-body'),
    ).toHaveText('Overall this reads well. One pass for tone and it ships.');
  });
});
test.describe('review comment lifecycle: permissions', () => {
  test.beforeEach(async ({ page }) => {
    await gotoHydrated(page, ROUTE);
    await openSidebar(page);
  });
  test('per-comment actions are author-scoped while `Delete thread` only needs a current user', async ({
    page,
  }) => {
    // `t-text` mixes authors: one comment by `steve` (the current user) and
    // one by `maya`.
    const mixed = await selectThread(page, rowQuoted(page, 'Release Plan'));
    const mine = mixed.locator('article.comment[data-comment-id="c-text-steve"]');
    const theirs = mixed.locator('article.comment[data-comment-id="c-text-maya"]');
    await expect(mine.locator('.comment-author-name')).toHaveText('steve');
    await expect(mine.getByRole('button', { name: 'Edit comment' })).toHaveCount(1);
    await expect(mine.getByRole('button', { name: 'Delete comment' })).toHaveCount(1);
    await expect(theirs.locator('.comment-author-name')).toHaveText('maya');
    await expect(theirs.getByRole('button', { name: 'Edit comment' })).toHaveCount(0);
    await expect(theirs.getByRole('button', { name: 'Delete comment' })).toHaveCount(0);
    await mixed.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(popover(page)).toHaveCount(0);
    // The asymmetry: `t-long` is authored ENTIRELY by `maya`, so there is not
    // one per-comment action on it — yet `Delete thread` is enabled, because
    // its only guard is `disabled={!currentUserId}`. Any signed-in reviewer
    // can delete someone else's whole thread but cannot delete a single
    // comment inside it.
    const theirThread = await selectThread(page, rowQuoted(page, 'Reviewers should verify'));
    await expect(theirThread.getByRole('button', { name: 'Edit comment' })).toHaveCount(0);
    await expect(theirThread.getByRole('button', { name: 'Delete comment' })).toHaveCount(0);
    await expect(theirThread.getByRole('button', { name: 'Delete thread' })).toBeEnabled();
  });
});
test.describe('review comment lifecycle: deletion is always soft', () => {
  test.beforeEach(async ({ page }) => {
    await gotoHydrated(page, ROUTE);
    await openSidebar(page);
  });
  test('a UI delete carries `soft: true` and leaves the comment in `threads` with a `deletedAt`', async ({
    page,
  }) => {
    const dialog = await selectThread(page, rowQuoted(page, 'Release Plan'));
    await expect(badge(page)).toHaveText('4');
    await dialog
      .locator('article.comment[data-comment-id="c-text-steve"]')
      .getByRole('button', { name: 'Delete comment' })
      .click();
    await expect(page.getByTestId('event-log').locator('li')).toHaveCount(1);
    const [deleted] = await payloadsFor(page, 'commentdelete');
    // Hard delete is reachable only through the imperative
    // `deleteComment(threadId, commentId, false)`; nothing in the rendered UI
    // can produce `soft: false`.
    expect(deleted).toEqual({ threadId: 't-text', commentId: 'c-text-steve', soft: true });
    // The comment stops rendering and stops counting…
    await expect(dialog.locator('article.comment[data-comment-id="c-text-steve"]')).toHaveCount(0);
    await expect(badge(page)).toHaveText('3');
    await expect(page.getByTestId('visible-comment-count')).toHaveText('visible comments: 3');
    // …but it is still in `threads`, carrying a timestamp. Soft delete is an
    // audit trail, not an erasure — `stored comments` never drops.
    await expect(page.getByTestId('stored-comment-count')).toHaveText('stored comments: 6');
    await expect(page.getByTestId('soft-deleted-ids')).toContainText('c-text-steve');
    // The thread itself survives: it still has a visible comment.
    await expect(page.getByTestId('thread-count')).toHaveText('threads: 4');
  });
  test('the same reducer call WITHOUT `deletedAt` applies, stamping the time itself', async ({
    page,
  }) => {
    // This test used to pin the opposite, and the pin was the point: what it
    // documented was the likeliest consumer mistake in the whole API.
    // `deleteComment(threads, t, c, { soft: true })` — no `deletedAt` — used to
    // return `{ changed: false }` and the identical array. No throw, no warn,
    // no partial application; the only way to notice was to read `changed`.
    //
    // Why that bailout was indefensible rather than merely strict: the delete
    // the component actually emits is `CommentDeleteEvent`, which carries only
    // `{ threadId, commentId, soft }`. There is no timestamp on it to forward,
    // so the obvious wiring — hand the event straight to the reducer —
    // typechecked, ran, and did nothing, AFTER ReviewEditor had already
    // announced "Comment deleted" to screen readers. The default path was the
    // broken one.
    //
    // Fixed: a soft delete that omits `deletedAt` now defaults it to
    // `timestamp()` inside the reducer, which is the only place that can see
    // the omission. An explicitly supplied `deletedAt` still wins verbatim and
    // hard delete is untouched — both pinned in the reducer-level test below,
    // because the page exposes ids but never the stamp values.
    await expect(page.getByTestId('visible-comment-count')).toHaveText('visible comments: 4');
    await expect(docRow(page).locator('p.thread-preview')).toHaveText(
      'Overall this reads well. One pass for tone and it ships.',
    );
    await page.getByTestId('delete-without-deletedat').click();
    await expect(page.getByTestId('last-changed')).toHaveText('last reducer changed: true');
    await expect(page.getByTestId('visible-comment-count')).toHaveText('visible comments: 3');
    await expect(badge(page)).toHaveText('3');
    // The stamp itself is observable, if indirectly: `soft-deleted-ids` is
    // derived by filtering on `comment.deletedAt`, so `c-doc-1` can only appear
    // there if the reducer wrote a truthy timestamp onto it — nobody passed one
    // in.
    await expect(page.getByTestId('soft-deleted-ids')).toContainText('c-doc-1');
    // Still soft, not an erasure: the comment is gone from the counts but not
    // from `threads`.
    await expect(page.getByTestId('stored-comment-count')).toHaveText('stored comments: 6');
    await expect(page.getByTestId('thread-count')).toHaveText('threads: 4');
    // `c-doc-1` was `t-doc`'s only comment, so applying the delete turns the
    // document thread into a ghost: it leaves the sidebar and the visible-thread
    // count while staying in `threads`. Under the old no-op the row simply
    // stayed put with its preview intact.
    await expect(docRow(page)).toHaveCount(0);
    await expect(page.getByTestId('visible-thread-count')).toHaveText('visible threads: 2');
    // Unchanged by the fix: this is a page-side reducer call, so the component
    // never hears about it and emits nothing.
    await expect(page.getByTestId('event-log').locator('li')).toHaveCount(0);
  });
});
