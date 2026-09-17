import { expect, test } from '@playwright/test';
import {
  ROUTE,
  events,
  gotoHydrated,
  lastReturn,
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
test.describe('review-imperative: the readonly guard', () => {
  test('all eight mutation methods are guarded, and a removed guard would be observable', async ({
    page,
  }) => {
    // The readonly instance is SEEDED with one document thread carrying one
    // comment, and its callbacks are wired to the same reducers as the editable
    // one. Both halves are load-bearing: with an empty array the void methods
    // receive '' and no-op on a missing id whether or not the guard exists, and
    // with no callbacks a fired event would leave no trace. Together they mean
    // deleting any of the eight guards turns this test red.
    await expect(page.getByTestId('ro-thread-count')).toHaveText('readonly threads: 1');
    await expect(page.getByTestId('ro-comment-bodies')).toHaveText(
      'Seeded so the readonly guards have something to refuse.',
    );

    // The three creates return null, which is the guard's whole signature.
    for (const testId of [
      'ro-create-thread',
      'ro-create-document-thread',
      'ro-create-block-thread',
    ]) {
      await page.getByTestId(testId).click();
      await expect(lastReturn(page)).toHaveText('last return: null');
    }

    // The five void methods return nothing, so they are asserted by absence:
    // no callback fired, and neither the array nor the comment body moved.
    for (const testId of [
      'ro-create-comment',
      'ro-update-comment',
      'ro-delete-comment',
      'ro-delete-thread',
      'ro-clear-all-threads',
    ]) {
      await page.getByTestId(testId).click();
    }

    await expect(page.getByTestId('ro-events')).toHaveText('');
    await expect(page.getByTestId('ro-thread-count')).toHaveText('readonly threads: 1');
    await expect(page.getByTestId('ro-comment-bodies')).toHaveText(
      'Seeded so the readonly guards have something to refuse.',
    );
  });

  test('every refused readonly call announces a refusal, never a completion', async ({ page }) => {
    // The previous version of this test clicked ONE button — `ro-create-thread`,
    // which returns null and got the right string by luck. The five void methods
    // return `undefined` whether refused or not, and all four were announcing
    // "completed" for a call the guard had refused: a false confirmation of a
    // destructive action, which is worse than the silence it replaced. So every
    // refusing button is asserted, not one.
    const announcement = page.getByTestId('announcement');
    await expect(announcement).toHaveCount(1);
    await expect(announcement).toHaveText('');

    const refusing = [
      'ro-create-thread',
      'ro-create-document-thread',
      'ro-create-block-thread',
      'ro-create-comment',
      'ro-update-comment',
      'ro-delete-comment',
      'ro-delete-thread',
      'ro-clear-all-threads',
    ];
    for (const testId of refusing) {
      await page.getByTestId(testId).click();
      await expect(announcement).toHaveText(/was refused: the editor is readonly/);
      await expect(announcement).not.toHaveText(/completed/);
    }

    // Nothing actually moved, which is what makes "refused" the honest word.
    await expect(page.getByTestId('ro-events')).toHaveText('');
    await expect(page.getByTestId('ro-thread-count')).toHaveText('readonly threads: 1');
  });

  test('a refusal on the EDITABLE instance never blames readonly', async ({ page }) => {
    // The first fix made every refusal say "the editor is readonly" — true for
    // the readonly instance, and FALSE here: this instance's mode never changes,
    // so a null return means no selection, no view, or no target — never
    // readonly. Reproduced live: Tab to `select-quote`, Enter, Tab to
    // `create-thread`, Enter — the region announced "the editor is readonly" for
    // a selection-lag failure (cinder#1288) on the WRITABLE editor. A confident,
    // specific, and false diagnosis is worse than a vague one.
    const announcement = page.getByTestId('announcement');

    // createThread: refused because no text is selected, on a fresh page with
    // nothing highlighted.
    await page.getByTestId('create-thread-nodomselect').click();
    await expect(lastReturn(page)).toHaveText('last return: null');
    await expect(announcement).toHaveText(/was refused: no text is currently selected/);
    // The tally legitimately says "in the readonly one", so the check is for
    // the DIAGNOSIS specifically, not the bare word anywhere in the string.
    await expect(announcement).not.toHaveText(/the editor is readonly/);

    // createComment: refused because no thread exists yet to comment on.
    await page.getByTestId('create-comment').click();
    await expect(lastReturn(page)).toHaveText('last return: null');
    await expect(announcement).toHaveText(/was refused: no thread exists to comment on/);
    await expect(announcement).not.toHaveText(/the editor is readonly/);

    // The three void methods that can target a missing thread/comment: each
    // says what was actually missing, never "completed" and never a readonly
    // diagnosis. "eligible" rather than "exists" — the wording that matters is
    // tested precisely by the soft-delete regression test below, where a
    // target DOES exist but is not an eligible one.
    await page.getByTestId('update-comment').click();
    await expect(announcement).toHaveText(/was refused: no eligible comment to update/);
    await expect(announcement).not.toHaveText(/^.*completed.*$|the editor is readonly/);

    await page.getByTestId('delete-comment-soft').click();
    await expect(announcement).toHaveText(/was refused: no eligible comment to delete/);
    await expect(announcement).not.toHaveText(/^.*completed.*$|the editor is readonly/);

    await page.getByTestId('delete-thread').click();
    await expect(announcement).toHaveText(/was refused: no eligible thread to delete/);
    await expect(announcement).not.toHaveText(/^.*completed.*$|the editor is readonly/);

    // Nothing was actually mutated by any of the five calls above.
    expect(await events(page)).toEqual([]);
    await expect(threadCount(page)).toHaveText('threads: 0');
  });

  test('a repeated action announces again, and bulk actions carry a count', async ({ page }) => {
    // `aria-live` fires on CHANGE, so an announcement that is a pure function of
    // the button name is silent from the second press onward. On a page whose
    // point is buttons that may refuse, re-pressing to check is the obvious
    // response — and it was exactly what produced nothing.
    const announcement = page.getByTestId('announcement');

    await page.getByTestId('create-document-thread').click();
    await expect(threadCount(page)).toHaveText('threads: 1');
    await expect(announcement).toHaveText(/1 thread in the editable review/);

    await page.getByTestId('create-document-thread').click();
    await expect(threadCount(page)).toHaveText('threads: 2');
    await expect(announcement).toHaveText(/2 threads in the editable review/);

    await page.getByTestId('create-document-thread').click();
    await expect(threadCount(page)).toHaveText('threads: 3');
    await expect(announcement).toHaveText(/3 threads in the editable review/);

    // A refused call repeats with an unchanged tally, so the text is identical
    // twice running. It must still RE-ANNOUNCE, which `toHaveText` cannot see:
    // it polls for a final string, so it stays green with the clear-then-set
    // deleted. A log of what was WRITTEN was tried first and rejected for the
    // same reason — it records an entry whether or not the DOM actually
    // changed. Instead the page counts real MUTATIONS of the live-region node
    // via `MutationObserver` (`announce-mutations`), which can only increase
    // when a write genuinely lands. Two presses must each move the counter,
    // which is false the moment the microtask transition goes away.
    const mutations = () =>
      page
        .getByTestId('announce-mutations')
        .textContent()
        .then((raw) => Number(raw ?? '0'));

    const before = await mutations();
    await page.getByTestId('ro-delete-thread').click();
    await expect.poll(mutations).toBeGreaterThan(before);
    const afterFirst = await mutations();

    // The SECOND identical press is the one that matters. Same words, same
    // tally — so without the clear-then-set Svelte writes the same string, the
    // DOM never changes, and a screen reader hears nothing.
    await page.getByTestId('ro-delete-thread').click();
    await expect.poll(mutations).toBeGreaterThan(afterFirst);
    await expect(announcement).toHaveText(/was refused/);

    // Bulk removal reports scale rather than merely happening.
    await page.getByTestId('clear-all-threads').click();
    await expect(threadCount(page)).toHaveText('threads: 0');
    await expect(announcement).toHaveText(
      /clearAllThreads completed\. 0 threads in the editable review/,
    );
  });

  test('a control that has to focus the editor puts focus back on itself', async ({ page }) => {
    // `select()` calls `view.focus()` for a real reason — ProseMirror observes a
    // selection on a focused view, and this page drives the documented consumer
    // path rather than faking it. Four buttons inherited that and silently
    // relocated focus into the contenteditable: `create-thread` is the first
    // control on the page and the editor is the twenty-third, so pressing it
    // moved a keyboard user twenty-odd stops forward with no announcement, and
    // reaching the next button meant walking back through the editor host, the
    // export menu, the sidebar toggle and every preceding control.
    //
    // Not a trap — Tab out of the editor worked — which is exactly why it went
    // unnoticed until the board drove the page by keyboard.
    const focusedTestId = () =>
      page.evaluate(
        () =>
          document.activeElement?.getAttribute('data-testid') ??
          document.activeElement?.tagName ??
          null,
      );

    for (const testId of [
      'select-quote',
      'create-thread',
      'create-block-thread',
      'create-block-thread-at-doc-start',
    ]) {
      const button = page.getByTestId(testId);
      await button.focus();
      await button.press('Enter');
      // Polled, not sampled: the restore happens after an awaited imperative
      // call, so reading once could catch the intermediate state where focus
      // legitimately sits in the view.
      await expect.poll(focusedTestId).toBe(testId);
    }
  });

  test('the page keeps one h1 after hydration, rather than one per editor', async ({ page }) => {
    // Each editor renders its document's first heading at the authored level, so
    // a `#` fixture adds an `h1` per instance — here that made three sibling
    // `h1`s, two of them nested inside `h2` sections.
    //
    // This is invisible to SSR and therefore to the hydration spec: the editors
    // server-render an empty shell, so the extra headings only exist after the
    // client mounts. Asserting after hydration is the point of the test.
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator('h1')).toHaveText('Review Imperative');
    await expect(page.locator('#imperative-editor .ProseMirror h3')).toHaveText('Release Plan');
    await expect(page.locator('#imperative-readonly .ProseMirror h3')).toHaveText(
      'Readonly Reference',
    );
  });

  test('clearAllThreads with nothing to clear announces a refusal, not a completion', async ({
    page,
  }) => {
    // It was the one void mutation method not routed through `recordVoid`, so it
    // announced "completed" unconditionally — including for a call that bailed
    // at `threads.length === 0` without firing anything. That is the same
    // defect the other four were fixed for, and it survived because the
    // existing bulk-removal test only ever presses it with threads present.
    const announcement = page.getByTestId('announcement');

    await expect(threadCount(page)).toHaveText('threads: 0');
    await page.getByTestId('clear-all-threads').click();

    await expect(announcement).toHaveText(/clearAllThreads was refused: no threads to clear/);
    await expect(announcement).not.toHaveText(/completed/);
    expect(await events(page)).toEqual([]);
  });

  test('the readonly instance is announced as readonly, not as an editable textbox', async ({
    page,
  }) => {
    // REGRESSION PIN for cinder#1292, fixed in @repo/editor@0.9.2.
    // `mode="readonly"` produced `contenteditable="false"` and a `data-readonly`
    // styling hook, but no ARIA state — so a screen reader announced an ordinary
    // editable text box that silently ignored typing. Measured before the fix:
    // both instances reported `readonly: false, settable: true`.
    //
    // Asserted on the ProseMirror node specifically, because that is where the
    // textbox role lives. The same attribute on the wrapping `role="application"`
    // host changes nothing — ARIA states do not inherit down to it — which is
    // what the originally-filed fix got wrong.
    const readonlySurface = page.locator('#imperative-readonly .ProseMirror');
    const editableSurface = page.locator('#imperative-editor .ProseMirror');

    await expect(readonlySurface).toHaveAttribute('aria-readonly', 'true');
    await expect(readonlySurface).toHaveAttribute('contenteditable', 'false');
    // The editable instance is the control: it must NOT pick the attribute up,
    // or the assertion above would pass against a component that sets it
    // unconditionally.
    await expect(editableSurface).not.toHaveAttribute('aria-readonly', 'true');
    await expect(editableSurface).toHaveAttribute('contenteditable', 'true');
  });

  test('deleting a thread from its own popover leaves focus somewhere reachable', async ({
    page,
  }) => {
    // REGRESSION PIN for cinder#1291, fixed in @repo/cinder@0.24.3 +
    // @repo/editor@0.9.2. The focus trap captured the sidebar item that
    // opened the popover and restored to it on close — but deleting the thread
    // removes that item, so the restore silently did nothing and focus landed on
    // `<body>`: the next Tab restarts at the top of the document, and a screen
    // reader says nothing.
    //
    // This route is where it surfaced precisely because it APPLIES
    // `onthreaddelete`. The other review-* routes are notification-only, so
    // their sidebar item survives the delete and the original restore path
    // still found its target — which is why every one of them stayed green.
    await page.getByTestId('create-document-thread').click();
    await expect(threadCount(page)).toHaveText('threads: 1');

    const host = page.locator('[data-testid="editor-host"]');
    await host.getByRole('button', { name: /comments sidebar/ }).click();
    const item = page.locator('#imperative-editor-sidebar button.thread-item').first();
    await item.click();

    const popover = page.locator('.thread-popover');
    await expect(popover).toBeVisible();
    await popover.getByRole('button', { name: 'Delete thread' }).click();
    await expect(threadCount(page)).toHaveText('threads: 0');

    // Focus is on the comments-sidebar toggle for THIS editor instance — always
    // mounted, always focusable, adjacent to the work, and its own label
    // announces the changed comment count.
    await expect
      .poll(() =>
        page.evaluate(() => ({
          id: document.activeElement?.id ?? null,
          isBody: document.activeElement === document.body,
        })),
      )
      .toEqual({ id: 'imperative-editor-sidebar-toggle', isBody: false });
  });

  test('setMarkdown is NOT guarded, so a readonly editor is programmatically mutable', async ({
    page,
  }) => {
    // Documented rather than asserted-as-correct. RE-3 calls this undecided;
    // the shipped component decides it one way: all eight mutation methods
    // guard on `mode === 'readonly'` and `setMarkdown`/`reset` do not. A
    // consumer treating `readonly` as "this content cannot change" is wrong.
    //
    // This is the `setMarkdown` half only, and it predates RE-3. The `reset`
    // half is the last test in the RE-3 block below; the two are deliberately
    // not merged, so neither can be read as standing in for the other.
    const before = await page.getByTestId('ro-value-length').textContent();
    await page.getByTestId('ro-set-markdown').click();
    await expect(page.getByTestId('ro-value-length')).not.toHaveText(before ?? '');
    await expect(page.getByTestId('ro-value-length')).toHaveText('readonly value length: 36');
  });
});
