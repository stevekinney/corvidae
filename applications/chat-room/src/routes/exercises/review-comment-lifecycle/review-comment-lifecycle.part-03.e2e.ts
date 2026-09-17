import { expect, test } from '@playwright/test';
import {
  ROUTE,
  announcer,
  badge,
  docRow,
  gotoHydrated,
  openSidebar,
  payloadsFor,
  popover,
  rowQuoted,
  selectThread,
  sidebar,
} from './review-comment-lifecycle-test-helpers';

// The reducer probe runs in the browser route. Importing the reducer helpers in
// Playwright's Node process also imports the editor root styles, which makes the
// test runner parse component CSS as JavaScript before the browser can run.
test.describe('review comment lifecycle: the reducer probe', () => {
  test.beforeEach(async ({ page }) => {
    await gotoHydrated(page, ROUTE);
  });

  test('an omitted `deletedAt` is defaulted to now; an explicit one is kept verbatim', async ({
    page,
  }) => {
    await page.getByTestId('run-reducer-probe').click();
    const probe = JSON.parse(await page.getByTestId('reducer-probe-json').innerText());

    expect(probe.defaulted.changed).toBe(true);
    expect(probe.defaulted.deletedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(probe.defaulted.withinCallWindow).toBe(true);
    expect(probe.explicit.changed).toBe(true);
    expect(probe.explicit.deletedAt).toBe('2019-03-04T05:06:07.008Z');
  });

  test('the surviving no-ops still no-op, and hard delete still erases without stamping', async ({
    page,
  }) => {
    await page.getByTestId('run-reducer-probe').click();
    const probe = JSON.parse(await page.getByTestId('reducer-probe-json').innerText());

    expect(probe.repeated.changed).toBe(false);
    expect(probe.repeated.keptIdentity).toBe(true);
    expect(probe.repeated.deletedAt).toBe('2019-03-04T05:06:07.008Z');
    expect(probe.unknown.deleteCommentUnknownThreadChanged).toBe(false);
    expect(probe.unknown.deleteCommentUnknownCommentChanged).toBe(false);
    expect(probe.hard.changed).toBe(true);
    expect(probe.hard.comments).toBe(0);
  });

  test('`updateComment` and `deleteThread` no-op on unknown ids too, array identity included', async ({
    page,
  }) => {
    await page.getByTestId('run-reducer-probe').click();
    const probe = JSON.parse(await page.getByTestId('reducer-probe-json').innerText());

    expect(probe.unknown.updateCommentUnknownThreadChanged).toBe(false);
    expect(probe.unknown.updateCommentUnknownCommentChanged).toBe(false);
    expect(probe.unknown.deleteThreadUnknownChanged).toBe(false);
    expect(probe.unknown.updateKeptIdentity).toBe(true);
    expect(probe.unknown.deleteThreadKeptIdentity).toBe(true);
    expect(probe.positive.deleteThreadChanged).toBe(true);
    expect(probe.positive.updateCommentChanged).toBe(true);
  });
});
test.describe('review comment lifecycle: ghost threads', () => {
  test.beforeEach(async ({ page }) => {
    await gotoHydrated(page, ROUTE);
  });
  test('a seeded thread whose only comment is soft-deleted stays anchored and opens an empty popover', async ({
    page,
  }) => {
    // `t-empty` is invisible to both counters but fully alive in the document.
    await expect(page.getByTestId('thread-count')).toHaveText('threads: 4');
    await expect(page.getByTestId('visible-thread-count')).toHaveText('visible threads: 3');
    await expect(badge(page)).toHaveText('4');
    // Exactly one decoration span, covering exactly the quoted range. Before
    // the fix in cinder PR #1266 a seeded thread decorated the entire
    // document, and this locator resolved to several spans. (The decoration
    // contract itself belongs to `review-anchoring`; it matters here only
    // because clicking the decoration is the ONLY way to reach a ghost.)
    const ghostAnchor = page.locator('span.comment-anchor[data-thread-id="t-empty"]');
    await expect(ghostAnchor).toHaveCount(1);
    await expect(ghostAnchor).toHaveText('Timeline risk');
    await ghostAnchor.click();
    const dialog = popover(page);
    await expect(dialog).toHaveAttribute('data-position-ready', 'true');
    await expect(dialog.locator('article.comment')).toHaveCount(0);
    await expect(dialog.locator('.comment-list-empty')).toHaveText('No comments yet.');
    // Still deletable, and still able to take a new reply — a ghost is a
    // thread with nothing to show, not a tombstone.
    await expect(dialog.getByRole('button', { name: 'Delete thread' })).toBeEnabled();
    await expect(dialog.locator('#lifecycle-editor-thread-popover-composer')).toBeVisible();
  });
  test('soft-deleting the last visible comment turns a live thread into a ghost in place', async ({
    page,
  }) => {
    await openSidebar(page);
    const dialog = await selectThread(page, docRow(page));
    await dialog
      .locator('article.comment[data-comment-id="c-doc-1"]')
      .getByRole('button', { name: 'Delete comment' })
      .click();
    // The row leaves the sidebar and the count drops…
    await expect(docRow(page)).toHaveCount(0);
    await expect(sidebar(page).locator('.thread-count')).toHaveText('2');
    // …while `threads` keeps all four, and the popover stays open on a thread
    // that no longer has anything to list.
    await expect(page.getByTestId('thread-count')).toHaveText('threads: 4');
    await expect(dialog.locator('.comment-list-empty')).toHaveText('No comments yet.');
  });
});
test.describe('review comment lifecycle: clear all', () => {
  test('the confirmation counts VISIBLE threads but `Delete All` deletes every thread', async ({
    page,
  }) => {
    await gotoHydrated(page, ROUTE);
    await openSidebar(page);
    await sidebar(page).getByRole('button', { name: 'Comment actions' }).click();
    // Scoped to the sidebar's own menu: the toolbar's export dropdown also
    // renders `[role="menuitem"]` children (Content / Summary / Git Diff /
    // Comments / JSON), and one of them is literally named `Comments`.
    const menu = page.locator('#lifecycle-editor-sidebar-actions-menu');
    await menu.getByRole('menuitem', { name: 'Clear all comments' }).click();
    const confirm = sidebar(page).getByRole('group', {
      name: 'Delete all 3 comment threads?',
    });
    await expect(confirm).toHaveAttribute('role', 'group');
    await expect(confirm).toHaveAttribute('aria-label', 'Delete all 3 comment threads?');
    // The banner interpolates the VISIBLE thread count — it says three.
    await expect(confirm).toContainText('Delete all 3 comment threads?');
    await confirm.getByRole('button', { name: 'Delete All' }).click();
    // …and then emits FOUR. `clearAllThreads` iterates `threads`, not the
    // filtered list the banner was counting, so the invisible ghost is deleted
    // by a dialog that never mentioned it. A consumer sizing an undo buffer or
    // a confirmation from that number is off by every ghost in the document.
    await expect(page.getByTestId('event-log').locator('li')).toHaveCount(4);
    const removed = await payloadsFor(page, 'threaddelete');
    expect(removed).toEqual([
      { threadId: 't-doc' },
      { threadId: 't-text' },
      { threadId: 't-long' },
      { threadId: 't-empty' },
    ]);
    await expect(page.getByTestId('thread-count')).toHaveText('threads: 0');
    await expect(page.locator('span.comment-anchor')).toHaveCount(0);
    await expect(sidebar(page).locator('.empty-message')).toHaveText('No comments yet');
    // With nothing left to act on, the stable actions trigger is disabled.
    await expect(sidebar(page).getByRole('button', { name: 'Comment actions' })).toBeDisabled();
  });
});
test.describe('review comment lifecycle: counts and announcements', () => {
  test.beforeEach(async ({ page }) => {
    await gotoHydrated(page, ROUTE);
  });
  test('the toolbar badge counts COMMENTS while the sidebar count counts THREADS', async ({
    page,
  }) => {
    // Two numbers, both sitting next to the word "Comments", both correct,
    // and never equal for this fixture: four visible comments across three
    // visible threads.
    await expect(badge(page)).toHaveText('4');
    await openSidebar(page);
    await expect(sidebar(page).locator('.thread-count')).toHaveText('3');
    // Only one of them reaches assistive tech as a number: the badge is
    // `aria-hidden`, and the count it carries is restated inside the toggle's
    // accessible name.
    await expect(badge(page)).toHaveAttribute('aria-hidden', 'true');
    await expect(
      page.getByRole('button', { name: 'Close comments sidebar (4 comments)' }),
    ).toHaveCount(1);
    // The sidebar's count is a bare `<span>` — no role, no label, no name.
    const countAttributes = await sidebar(page)
      .locator('.thread-count')
      .evaluate((element) => element.getAttributeNames());
    expect(countAttributes.filter((name) => name !== 'class')).toEqual([]);
  });
  test('the live announcer is empty on first paint and then mirrors the toggle, singular included', async ({
    page,
  }) => {
    // `[role="status"]` alone is ambiguous — the editor also mounts a generic
    // LiveRegion with the same role. Both are `cinder-sr-only` as of cinder PR
    // #1266, so neither is reachable by visible text; scope by class.
    await expect(announcer(page)).toHaveClass(/cinder-sr-only/);
    await expect(announcer(page)).toHaveAttribute('aria-live', 'polite');
    await expect(announcer(page)).toHaveAttribute('aria-atomic', 'true');
    // Deliberate do-not-announce-on-mount guard: the count is 4, and the
    // region says nothing.
    await expect(announcer(page)).toBeEmpty();
    await openSidebar(page);
    // Walk the count down to one. `t-long` is authored by `maya`, so the only
    // way to remove its comment is to delete the whole thread; the remaining
    // two deletions are per-comment on `steve`'s own.
    const theirThread = await selectThread(page, rowQuoted(page, 'Reviewers should verify'));
    await theirThread.getByRole('button', { name: 'Delete thread' }).click();
    // Deleting a thread closes its popover; wait for that before selecting the
    // next one, so `selectThread` cannot latch onto the outgoing dialog.
    await expect(popover(page)).toHaveCount(0);
    await expect(announcer(page)).toHaveText('3 comments');
    const mixed = await selectThread(page, rowQuoted(page, 'Release Plan'));
    await mixed
      .locator('article.comment[data-comment-id="c-text-steve"]')
      .getByRole('button', { name: 'Delete comment' })
      .click();
    await expect(announcer(page)).toHaveText('2 comments');
    await mixed.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(popover(page)).toHaveCount(0);
    const documentThread = await selectThread(page, docRow(page));
    await documentThread
      .locator('article.comment[data-comment-id="c-doc-1"]')
      .getByRole('button', { name: 'Delete comment' })
      .click();
    // Singular, and the toggle's accessible name uses the identical rule.
    await expect(announcer(page)).toHaveText('1 comment');
    await expect(
      page.getByRole('button', { name: 'Close comments sidebar (1 comment)' }),
    ).toHaveCount(1);
    await expect(badge(page)).toHaveText('1');
  });
});
