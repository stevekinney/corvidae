import { expect, test } from '@playwright/test';
import type { Page } from './review-comment-lifecycle-test-helpers';
import {
  ROUTE,
  gotoHydrated,
  openSidebar,
  payloadsFor,
  popover,
  rowQuoted,
  selectThread,
} from './review-comment-lifecycle-test-helpers';

/**
 * The observed-state readouts as one object, for a before/after comparison.
 *
 * Deliberately excludes `last-changed`, `counts-at-last-event`, and the
 * deferral readouts: those are the ones the flush is SUPPOSED to move, and
 * folding them in would make the comparison assert nothing.
 */
async function observedState(page: Page): Promise<Record<string, string | null>> {
  const testIds = [
    'thread-count',
    'visible-thread-count',
    'visible-comment-count',
    'stored-comment-count',
    'soft-deleted-ids',
    'thread-ids',
    'seeded-anchors',
  ];
  const entries = await Promise.all(
    testIds.map(async (id) => [id, await page.getByTestId(id).textContent()] as const),
  );
  return Object.fromEntries(entries);
}

// ROADMAP TI-2, and the item's premise did not survive contact with the package.
//
// TI-2 asked for a UI-driven test in which a stale `threadId`/`commentId` reaches
// the reducer, on the theory that a real user action could produce one the way a
// bare `deleteComment(threads, 't-nope', …)` call does. It cannot, and that is
// worth recording rather than quietly redefining, because the reason is a design
// decision the package states out loud: every mutation method documents "silent
// no-op behavior supports declarative UI patterns where callers don't need to
// pre-check conditions."
//
// Re-verified against the installed `@repo/editor@0.11.0`, in
// `dist/components/review-editor/review-editor-impl.svelte` (line numbers moved
// from the 0.10.0 build this comment originally cited; the behavior did not):
//
//   - `updateComment` (:1713) and `deleteComment` (:1743) both re-look-up the id
//     in the CURRENT `threads` and `return` before touching the callback.
//   - `deleteThread` (:1630) does the same, and `clearAllThreads` (:1648) emits
//     each thread's id while that thread is still in the array.
//   - The popover delegates straight to those three (`handlePopoverDelete` /
//     `handlePopoverCommentUpdate` / `handlePopoverCommentDelete`, :405-424), so
//     the rendered UI has no path around them.
//   - `popoverThread` is `$derived` from `threads` and the popover renders under
//     `{#if popoverThread && popoverPosition}`, with an `$effect` (:306) that
//     nulls `popoverThreadId` as well — so a popover cannot be held open over a
//     thread that has left the array and re-fired against it.
//
// So the first test below is the honest empirical version of "click Delete
// twice": the control is gone the second time. What remains of TI-2 is its own
// other half — the DELAYED CALLBACK — and that gap is by definition on the
// consumer, so the page models it: `arm-deferral` queues the next comment event
// instead of applying it, a real `Delete thread` click removes the thread in
// between, and `flush-deferred` applies the queued payload afterwards. The id
// that reaches the reducer is still the component's own, minted from a real
// click; only the moment of application moved.
test.describe('review comment lifecycle: a stale id reaching the reducer', () => {
  const EDITED_BODY = 'Renaming it now would break the changelog.';
  const ORIGINAL_BODY = 'Should this say "Launch Plan" instead?';

  test.beforeEach(async ({ page }) => {
    await gotoHydrated(page, ROUTE);
  });
  test('the direct path is closed: the UI withdraws each control before it can fire twice', async ({
    page,
  }) => {
    await openSidebar(page);
    const dialog = await selectThread(page, rowQuoted(page, 'Release Plan'));
    const mine = dialog.locator('article.comment[data-comment-id="c-text-steve"]');
    await mine.getByRole('button', { name: 'Delete comment' }).click();
    // The comment-level half, and the one with a real break lever:
    // `comment-list.svelte` filters soft-deleted comments out of its `{#each}`,
    // so the article carrying the Delete button is unmounted along with it.
    // There is no second click to make, which is why "click Delete twice" is
    // not a test that can exist here.
    await expect(mine).toHaveCount(0);
    // One comment left — `maya`'s — and it is not `steve`'s to delete, so the
    // popover now offers no Delete comment button at all. The counts are stated
    // rather than just asserting "zero buttons", which a blank popover would
    // also satisfy.
    await expect(dialog.locator('article.comment')).toHaveCount(1);
    await expect(dialog.locator('article.comment')).toHaveAttribute(
      'data-comment-id',
      'c-text-maya',
    );
    await expect(dialog.getByRole('button', { name: 'Delete comment' })).toHaveCount(0);
    // The thread-level half. Weaker as a pin, and said so plainly: the popover
    // is guarded twice over — `handlePopoverDelete` closes it explicitly AND
    // `popoverThread` derives to null once the thread leaves `threads` — so no
    // single-line edit upstream can make this assertion fail. It is recorded
    // because it is the other half of why the direct path is closed, not
    // because it independently pins anything.
    await dialog.getByRole('button', { name: 'Delete thread' }).click();
    await expect(popover(page)).toHaveCount(0);
    await expect(rowQuoted(page, 'Release Plan')).toHaveCount(0);
    // Two emissions, two distinct live ids. Neither is stale: at the instant
    // each fired, its subject was still in `threads`.
    await expect(page.getByTestId('event-log').locator('li')).toHaveCount(2);
    expect(await payloadsFor(page, 'commentdelete')).toEqual([
      { threadId: 't-text', commentId: 'c-text-steve', soft: true },
    ]);
    expect(await payloadsFor(page, 'threaddelete')).toEqual([{ threadId: 't-text' }]);
  });
  test('a deferred `commentdelete` flushed after its thread is gone no-ops and keeps the array', async ({
    page,
  }) => {
    // Arm before opening the sidebar, not after. The popover traps focus (it
    // is non-modal per cinder#1305, but Tab still cycles only its own
    // controls while open), and these controls sit outside it — reaching for
    // them mid-flow would be a click the real scenario never makes.
    await page.getByTestId('arm-deferral').click();
    await expect(page.getByTestId('deferral-armed')).toHaveText('deferral armed: true');
    await openSidebar(page);
    const dialog = await selectThread(page, rowQuoted(page, 'Release Plan'));
    await dialog
      .locator('article.comment[data-comment-id="c-text-steve"]')
      .getByRole('button', { name: 'Delete comment' })
      .click();
    // The queued payload, verbatim as the component emitted it. This assertion
    // is what makes the stale id component-authored: nothing in this spec ever
    // hands `t-text` to the reducer, and if the component minted a different
    // id here the test would say so.
    await expect(page.getByTestId('deferred-queue')).toHaveText(
      'deferred: commentdelete {"threadId":"t-text","commentId":"c-text-steve","soft":true}',
    );
    // The arm is one-shot and spent, so the `onthreaddelete` coming next is
    // applied normally rather than swallowed by the same queue.
    await expect(page.getByTestId('deferral-armed')).toHaveText('deferral armed: false');
    // Intercepted, not applied: the comment is still rendered and still counted.
    await expect(dialog.locator('article.comment[data-comment-id="c-text-steve"]')).toHaveCount(1);
    await expect(page.getByTestId('visible-comment-count')).toHaveText('visible comments: 4');
    // The removal in between, through the component's own UI rather than a
    // page-side splice — this is the step that makes the queued id stale.
    await dialog.getByRole('button', { name: 'Delete thread' }).click();
    await expect(popover(page)).toHaveCount(0);
    await expect(page.getByTestId('thread-ids')).toHaveText('thread ids: t-doc,t-long,t-empty');
    // Corroborates the interception from the component's side: when
    // `onthreaddelete` fired, `threads` still held all four threads and all six
    // stored comments, so the queued delete really had not been applied.
    await expect(page.getByTestId('counts-at-last-event')).toHaveText(
      'at event time: threads:4 visible:4 stored:6',
    );
    // `true` first is what gives the flip below its meaning: the readout can
    // move, and the flush is what moves it back.
    await expect(page.getByTestId('last-changed')).toHaveText('last reducer changed: true');
    const before = await observedState(page);
    await page.getByTestId('flush-deferred').click();
    // Three separable facts, and each has its own way of going wrong. The
    // reducer ran at all (only `apply*` writes `last-changed`); it reported no
    // change; and it handed back the IDENTICAL array rather than a fresh one
    // with the same contents — the second and third are independent, since a
    // helper that fell through to `threads.map(...)` on an unknown id would
    // still say `changed: false` while invalidating every consumer reference.
    await expect(page.getByTestId('last-changed')).toHaveText('last reducer changed: false');
    await expect(page.getByTestId('flush-identity')).toHaveText('flush kept array identity: true');
    await expect(page.getByTestId('deferred-queue')).toHaveText('deferred: —');
    expect(await observedState(page)).toEqual(before);
    // Still two events. The flush is consumer-side, so the component neither
    // hears about it nor re-emits — a stale id cannot bounce back into the UI.
    await expect(page.getByTestId('event-log').locator('li')).toHaveCount(2);
  });
  test('a deferred `commentupdate` flushed after its thread is gone no-ops the same way', async ({
    page,
  }) => {
    // `updateComment` had no unknown-id coverage anywhere in this repo before
    // this test and its reducer-direct sibling above — only `deleteComment`
    // did. TI-2 names both.
    await page.getByTestId('arm-deferral').click();
    await openSidebar(page);
    const dialog = await selectThread(page, rowQuoted(page, 'Release Plan'));
    const comment = dialog.locator('article.comment[data-comment-id="c-text-steve"]');
    await comment.getByRole('button', { name: 'Edit comment' }).click();
    // No surrounding whitespace: `saveEdit` trims before emitting, and the
    // queued payload is compared byte-for-byte below.
    await dialog.locator('#c-text-steve-edit').fill(EDITED_BODY);
    await dialog.locator('#c-text-steve-edit').press('ControlOrMeta+Enter');
    await expect(page.getByTestId('deferred-queue')).toHaveText(
      `deferred: commentupdate {"threadId":"t-text","commentId":"c-text-steve","body":"${EDITED_BODY}"}`,
    );
    await expect(page.getByTestId('deferral-armed')).toHaveText('deferral armed: false');
    // `saveEdit` calls `cancelEdit()` straight after `onupdate` regardless of
    // what the consumer does, so the edit form closing proves nothing on its
    // own. The body reverting to the ORIGINAL text is the proof: the component
    // renders `threads`, and `threads` never moved.
    await expect(comment.locator('.comment-body')).toHaveText(ORIGINAL_BODY);
    await expect(comment.locator('.comment-edited')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Delete thread' }).click();
    await expect(popover(page)).toHaveCount(0);
    await expect(page.getByTestId('thread-ids')).toHaveText('thread ids: t-doc,t-long,t-empty');
    await expect(page.getByTestId('last-changed')).toHaveText('last reducer changed: true');
    const before = await observedState(page);
    await page.getByTestId('flush-deferred').click();
    await expect(page.getByTestId('last-changed')).toHaveText('last reducer changed: false');
    await expect(page.getByTestId('flush-identity')).toHaveText('flush kept array identity: true');
    await expect(page.getByTestId('deferred-queue')).toHaveText('deferred: —');
    expect(await observedState(page)).toEqual(before);
    await expect(page.getByTestId('event-log').locator('li')).toHaveCount(2);
  });
});
