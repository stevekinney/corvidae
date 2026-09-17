import { expect, test } from '@playwright/test';
import {
  ROUTE,
  anchors,
  createAnchored,
  defined,
  events,
  firstAnchor,
  gotoHydrated,
  readoutText,
  threadCount,
} from './review-imperative-test-helpers';

test.beforeEach(async ({ page }) => {
  await gotoHydrated(page, ROUTE);
  // Matching the `ready()` gate every other review-* spec uses. Without it this
  // file failed 3 of 8 repeats with `Cannot read properties of null` on the
  // selection readout, and 7 of 55 across the suite — a racy setup that reads as
  // a component bug. All FOUR editors must be up — the two RE-1 instances plus
  // the RE-3 and RE-4 ones — so the count is 4.
  await expect(page.locator('[data-testid="review-editor"][data-ready="true"]')).toHaveCount(4);
  await expect(page.locator('#imperative-editor .ProseMirror')).toBeVisible();
  await expect(page.locator('#imperative-readonly .ProseMirror')).toBeVisible();
  await expect(page.locator('#imperative-content .ProseMirror')).toBeVisible();
  await expect(page.locator('#imperative-tall .ProseMirror')).toBeVisible();
  await expect(threadCount(page)).toHaveText('threads: 0');
});
test.describe('review-imperative: comment mutation', () => {
  test('createComment, updateComment, and deleteComment each notify and move the array', async ({
    page,
  }) => {
    const id = await createAnchored(page);

    await page.getByTestId('create-comment').click();
    await expect
      .poll(async () => {
        const anchor = await firstAnchor(page);
        return anchor.comments;
      })
      .toBe(2);
    expect(await events(page)).toContain(`oncommentcreate:${id}`);

    await page.getByTestId('update-comment').click();
    expect(await events(page)).toContain(`oncommentupdate:${id}`);
    // Assert the CONTENT, not just that an event fired: the previous version
    // checked only the event string, so an update that changed nothing passed.
    await expect(page.getByTestId('comment-bodies')).toContainText('Edited body');

    // The default is a SOFT delete: `soft` rides on the event, and the comment
    // stays in the array with a deletedAt stamp rather than being removed.
    await page.getByTestId('delete-comment-soft').click();
    expect(await events(page)).toContain(`oncommentdelete:${id}:soft=true`);
    const softDeletedAnchor = await firstAnchor(page);
    expect(softDeletedAnchor.comments).toBe(2);

    // The hard delete is the other half of the method's surface and was
    // previously wired to a button no test ever clicked.
    await page.getByTestId('delete-comment-hard').click();
    expect(await events(page)).toContain(`oncommentdelete:${id}:soft=false`);
    await expect
      .poll(async () => {
        const anchor = await firstAnchor(page);
        return anchor.comments;
      })
      .toBe(1);
  });

  test('the soft-delete reducer stamps deletedAt when it is omitted, and honours it when given', async ({
    page,
  }) => {
    // The component method takes `soft?: boolean` and has no deletedAt parameter.
    // The reducer owns that value-level contract, so this assertion runs through
    // the lifecycle page's browser-side reducer probe instead of importing the
    // component package into Playwright's Node process.
    await gotoHydrated(page, '/exercises/review-comment-lifecycle');
    await page.getByTestId('run-reducer-probe').click();
    const probe = JSON.parse(await readoutText(page, 'reducer-probe-json'));

    expect(probe.defaulted.changed).toBe(true);
    expect(probe.defaulted.deletedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(probe.defaulted.withinCallWindow).toBe(true);
    expect(probe.explicit.deletedAt).toBe('2019-03-04T05:06:07.008Z');
    expect(probe.hard.comments).toBe(0);
  });

  test('updateComment on an already-soft-deleted comment announces refused, not completed', async ({
    page,
  }) => {
    // KNOWN BUG, pinned as-is until here: an id-presence pre-check ("does a
    // comment with this id exist") is not the same question as the guard's own
    // ("does an ELIGIBLE comment exist"). Soft-delete only stamps `deletedAt` —
    // the comment entry stays in the array — so a presence check says
    // "completed" for a call the component's own guard silently refused.
    await createAnchored(page);
    const anchor = await firstAnchor(page);
    const id = anchor.id;

    await page.getByTestId('delete-comment-soft').click();
    expect(await events(page)).toContain(`oncommentdelete:${id}:soft=true`);
    const eventsBeforeUpdate = await events(page);

    const announcement = page.getByTestId('announcement');
    await page.getByTestId('update-comment').click();

    // No oncommentupdate fired, and the body was never touched.
    expect(await events(page)).toEqual(eventsBeforeUpdate);
    await expect(page.getByTestId('comment-bodies')).not.toContainText('Edited body');
    await expect(announcement).toHaveText(/was refused: no eligible comment to update/);
    await expect(announcement).not.toHaveText(/completed/);
  });

  test('a second soft-delete of the same comment announces refused, not a repeat completion', async ({
    page,
  }) => {
    // Same defect, corroborating instance: the guard refuses a second
    // soft-delete of an already-deleted comment. The id is still present, so
    // this fails identically to the updateComment case above unless the page
    // observes whether oncommentdelete actually fired again.
    await createAnchored(page);
    const anchor = await firstAnchor(page);
    const id = anchor.id;

    await page.getByTestId('delete-comment-soft').click();
    expect(await events(page)).toContain(`oncommentdelete:${id}:soft=true`);
    const eventsBeforeSecond = await events(page);

    const announcement = page.getByTestId('announcement');
    await page.getByTestId('delete-comment-soft').click();

    expect(await events(page)).toEqual(eventsBeforeSecond);
    await expect(announcement).toHaveText(/was refused: no eligible comment to delete/);
    await expect(announcement).not.toHaveText(/completed/);
  });

  test('createComment announces "a comment", never "a thread"', async ({ page }) => {
    // KNOWN BUG, pinned as-is until here: the 'created' message was shared
    // verbatim across all four create methods and said "created a thread"
    // unconditionally — including for createComment, which creates a comment
    // on an EXISTING thread. The component's own internal live region
    // correctly announces "Comment added" at the same moment, so a screen
    // reader hearing both got two contradictory descriptions of one action.
    await createAnchored(page);
    const announcement = page.getByTestId('announcement');

    await page.getByTestId('create-comment').click();
    await expect(announcement).toHaveText(/createComment created a comment\./);
    await expect(announcement).not.toHaveText(/created a thread/);
  });
});

test.describe('review-imperative: removal', () => {
  test('deleteThread and clearAllThreads fire onthreaddelete, once per thread', async ({
    page,
  }) => {
    const first = await createAnchored(page);
    await page.getByTestId('create-document-thread').click();
    await expect(threadCount(page)).toHaveText('threads: 2');
    const beforeDeleteRows = await anchors(page);
    const second = defined(
      beforeDeleteRows.find((row) => row.id !== first),
      'second created thread',
    ).id;

    await page.getByTestId('delete-thread').click();
    await expect(threadCount(page)).toHaveText('threads: 1');
    expect(await events(page)).toContain(`onthreaddelete:${first}`);
    // The SURVIVOR is the other thread, not merely "one fewer". A count alone
    // would pass if deleteThread removed the wrong one.
    const afterDeleteRows = await anchors(page);
    expect(afterDeleteRows.map((row) => row.id)).toEqual([second]);

    // Rebuild to TWO threads before clearing. Clearing a single remaining
    // thread cannot distinguish "one event per thread" from "one bulk event
    // that happens to carry a threadId", which is what the previous version of
    // this test actually proved.
    await page.getByTestId('create-document-thread').click();
    await expect(threadCount(page)).toHaveText('threads: 2');
    const remainingRows = await anchors(page);
    const remaining = remainingRows.map((row) => row.id);
    expect(remaining).toHaveLength(2);

    const beforeClear = await events(page);
    await page.getByTestId('clear-all-threads').click();
    await expect(threadCount(page)).toHaveText('threads: 0');

    const afterClearEvents = await events(page);
    const fired = afterClearEvents.slice(beforeClear.length);
    expect(fired).toHaveLength(2);
    expect(fired.toSorted()).toEqual(remaining.map((id) => `onthreaddelete:${id}`).toSorted());
  });

  test('orphaning fires no onthreaddelete, unlike a consumer-initiated delete', async ({
    page,
  }) => {
    await createAnchored(page);
    const eventsBefore = await events(page);

    // Remove the quoted text so the anchor can no longer be found. This is the
    // ORPHANING path, and RE-1 asks specifically that it be distinguished from
    // removal: the thread is still the consumer's, so nothing is deleted and
    // nothing is announced.
    await page.getByTestId('remove-quote').click();
    await expect
      .poll(async () => {
        const rows = await anchors(page);
        return rows[0]?.status;
      })
      .toBe('orphaned');

    await expect(threadCount(page)).toHaveText('threads: 1');
    expect(await events(page)).toEqual(eventsBefore);
  });
});
