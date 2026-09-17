import { expect, test } from '@playwright/test';
import {
  SEEDED_DRIFT_ANCHOR,
  anchorJson,
  anchorState,
  ready,
} from './review-anchoring-test-helpers';

// A fresh page per test. Several of these tests mutate their instance
// irreversibly — deleting the anchored word, moving it, replacing `value` — so
// sharing one page would make the suite order-dependent.
test.beforeEach(async ({ page }) => {
  await ready(page);
});
test.describe('review-anchoring: drift under ordinary editing', () => {
  test("text inserted at the anchor's LEFT edge is absorbed, and the prop never hears about it", async ({
    page,
  }) => {
    // The plugin maps `from` with bias -1, so a character inserted at exactly
    // `from` lands inside the range rather than before it.
    const anchor = page.locator('#anchor-drift .comment-anchor');
    await page.getByTestId('drift-insert-before').click();
    await expect(anchor).toHaveText('Xdashboard');

    // The plugin rewrote ITS copy of the quote to "Xdashboard". The bindable
    // `threads` prop is not on that path: only the deferred re-anchoring pass
    // publishes anchor updates, and it does not run here at all.
    //
    // "At all" is the assertion, and it is why this is a flag read rather than
    // a wait. An insertion at the anchor's own edge overlaps its stored range,
    // and the anchor verifiably described its own text beforehand, so the
    // transaction takes the plugin's "follow the edit" branch — which rewrites
    // quote/prefix/suffix in place and never raises `needsReanchor`. Nothing is
    // scheduled, so there is no debounce to outlast; a sleep here was waiting
    // for a timer that does not exist, and could not tell that apart from a
    // timer that fires one millisecond after it gave up.
    expect(await anchorState(page, 'drift')).toEqual({
      needsReanchor: false,
      statuses: { 'drift-dashboard': 'anchored' },
    });
    expect(await anchorJson(page, 'drift-json')).toEqual(SEEDED_DRIFT_ANCHOR);
  });

  test("text inserted at the anchor's RIGHT edge is absorbed too", async ({ page }) => {
    // `to` maps with bias +1, so the anchor is greedy at both ends.
    const anchor = page.locator('#anchor-drift .comment-anchor');
    await page.getByTestId('drift-insert-after').click();
    await expect(anchor).toHaveText('dashboard!');

    // Same branch, same silence, asserted the same way as the left edge above.
    expect(await anchorState(page, 'drift')).toEqual({
      needsReanchor: false,
      statuses: { 'drift-dashboard': 'anchored' },
    });
    expect(await anchorJson(page, 'drift-json')).toEqual(SEEDED_DRIFT_ANCHOR);
  });

  test('deleting the anchored text ORPHANS the thread and keeps it, silently to onthreaddelete', async ({
    page,
  }) => {
    // This used to delete the thread outright. `comments/types.ts` even
    // documented that as the reason `AnchorStatus` had no "orphaned" member:
    // "When anchor text is deleted, threads are automatically removed." The
    // plugin saw a collapsed range, the deferred pass failed to find the quote
    // anywhere, and the component dropped the thread from the bindable array
    // and fired `onthreaddelete`.
    //
    // cinder#1284 reversed that on purpose. At the moment text disappears, a
    // deletion and the first half of a cut-and-paste look identical, and the
    // re-anchoring pass runs 300ms later — faster than any person cutting a
    // paragraph and pasting it back. So the old behaviour destroyed comments
    // during ordinary editing, with no undo. `AnchorStatus` now has
    // 'orphaned': the anchor is marked, the thread STAYS in the bindable
    // array, and it is retried on every later re-anchoring pass. Removing a
    // thread is the consumer's decision now, so `onthreaddelete` does not fire
    // here at all.
    await page.getByTestId('drift-delete').click();

    // Kept, not removed — and the anchor keeps everything a later recovery
    // needs: its quote, its context, and its last known offset. Only `status`
    // changes, plus the collapsed range the deletion left behind.
    await expect
      .poll(() => anchorJson(page, 'drift-json'))
      .toEqual({
        from: 44,
        to: 44,
        quote: 'dashboard',
        prefix: 'The first release includes a ',
        suffix: ' and export actions.',
        status: 'orphaned',
        originalQuote: 'dashboard',
        lastKnownOffset: 42,
      });
    await expect(page.getByTestId('drift-thread-count')).toHaveText('threads: 1');
    // An orphaned anchor has no text to highlight, so it renders no
    // decoration. That is the visible half of "kept but not placed".
    await expect(page.locator('#anchor-drift .comment-anchor')).toHaveCount(0);

    // The announcement goes to a correctly hidden `role="status"` region, so
    // it is never visible text — and it clears itself after 1000ms. The page
    // mirrors it into an append-only log precisely so this assertion is not
    // racing that timer. The wording is the polite one the new contract calls
    // for: it reports the text is gone and says the comment survived.
    await expect(page.getByTestId('announcements')).toContainText(
      'The text a comment was anchored to is no longer in the document. The comment is kept.',
    );

    // The thread's survival is permanent, and the proof is structural rather
    // than temporal. The pass has demonstrably run — it is what published the
    // `orphaned` status the poll above waited for — and it left the flag DOWN:
    // the sync handler declines to re-raise `needsReanchor` for an anchor that
    // is already orphaned, precisely so an idle document does not schedule the
    // same failing pass forever. Only a later document change re-raises it, and
    // this test makes none. So there is no pending work left that could still
    // remove the thread, which is a stronger statement than "none had removed
    // it yet after 900ms".
    expect(await anchorState(page, 'drift')).toEqual({
      needsReanchor: false,
      statuses: { 'drift-dashboard': 'orphaned' },
    });
    await expect(page.getByTestId('drift-thread-count')).toHaveText('threads: 1');
    await expect(page.getByTestId('event-log')).toBeEmpty();

    // The sidebar is where an orphaned thread is reachable at all, since the
    // document shows nothing. It is marked for styling and, more importantly,
    // says so in words.
    await page
      .getByTestId('instance-drift')
      .getByRole('button', { name: /comments sidebar/ })
      .click();
    const items = page.locator('#anchor-drift-sidebar .thread-item');
    await expect(items).toHaveCount(1);
    await expect(items.first()).toHaveAttribute('data-orphaned', 'true');
    await expect(items.first()).toContainText('Quoted text is not in the document');
    await expect(items.first()).toContainText('dashboard');
  });

  test('delete-and-reinsert inside the debounce moves the anchor AND writes it back', async ({
    page,
  }) => {
    // Both edits in one synchronous burst, so the 300ms timer only ever fires
    // once, against the finished document. This is the sole path that
    // publishes new coordinates through the bindable prop.
    await page.getByTestId('drift-move-burst').click();

    await expect(page.locator('#anchor-drift p')).toHaveText(/^dashboard The first release/);
    await expect(page.locator('#anchor-drift .comment-anchor')).toHaveText('dashboard');
    await expect(page.getByTestId('drift-thread-count')).toHaveText('threads: 1');
    await expect(page.getByTestId('event-log')).toBeEmpty();

    // Everything positional changes together: the ProseMirror range, the
    // textBetween offset, and freshly recomputed context on both sides.
    // `originalQuote` is the only field deliberately frozen.
    await expect
      .poll(() => anchorJson(page, 'drift-json'))
      .toEqual({
        from: 15,
        to: 24,
        quote: 'dashboard',
        prefix: 'Release Plan\n',
        suffix: ' The first release includes a  and export actions.',
        status: 'anchored',
        originalQuote: 'dashboard',
        lastKnownOffset: 13,
      });
  });

  test('the same move with a 450ms pause orphans the anchor, and the late paste RECOVERS it', async ({
    page,
  }) => {
    // Identical edits and identical end state to the burst above, 450ms apart
    // instead of 0ms — the interval a real cut-and-paste takes, since no human
    // works inside the 300ms debounce. This test is the whole reason cinder#1284
    // exists: the debounce expires during the gap, the deferred pass finds no
    // "dashboard" in the document, and the old build deleted the thread on the
    // spot. Pasting the word back verbatim could not undo that, because there
    // was no thread left to re-anchor. An ordinary edit ate a comment.
    //
    // Now the vanished quote only ORPHANS the anchor. The thread stays in the
    // bindable array, renders no decoration while its text is missing, and is
    // retried on every later re-anchoring pass — so the paste that lands 450ms
    // later restores the anchor completely.
    await page.getByTestId('drift-move-slow').click();

    // Proof that the debounce really did expire inside the gap, rather than
    // the paste sneaking in under it and making this a re-run of the burst
    // case: the component announced the orphaning. That log is append-only, so
    // reading it does not race the recovery that follows.
    await expect(page.getByTestId('announcements')).toContainText(
      'The text a comment was anchored to is no longer in the document. The comment is kept.',
    );
    // Orphaned rather than deleted, even mid-gap.
    await expect(page.getByTestId('drift-thread-count')).toHaveText('threads: 1');

    // This assertion IS the wait for the whole recovery, which is why it now
    // comes first rather than last. It cannot pass early — nothing writes
    // `from: 15` into the bindable prop until the second re-anchoring pass has
    // found the restored quote and published it — and it cannot pass late,
    // because the auto-retrying matcher keeps looking. The previous shape slept
    // past the fixture's 450ms pause plus the debounce it restarts and then
    // asserted; the ordering below removes the guess without removing anything
    // the test claimed.
    //
    // (The 450ms itself is the FIXTURE's timer, in the page's
    // `moveAnchoredWordSlowly`, and it is the behaviour under test — the whole
    // point is that a human cut-and-paste lands outside the debounce. It is not
    // a test sleep and must not be converted.)
    //
    // Recovery is total, not partial: `status` is back to 'anchored' and every
    // positional field matches what the one-burst move produced. Byte for byte
    // the same anchor, reached the slow way.
    await expect
      .poll(() => anchorJson(page, 'drift-json'))
      .toEqual({
        from: 15,
        to: 24,
        quote: 'dashboard',
        prefix: 'Release Plan\n',
        suffix: ' The first release includes a  and export actions.',
        status: 'anchored',
        originalQuote: 'dashboard',
        lastKnownOffset: 13,
      });
    // …and the plugin agrees with the prop, with nothing further pending: a
    // second retry still queued would mean the anchor above could yet move.
    expect(await anchorState(page, 'drift')).toEqual({
      needsReanchor: false,
      statuses: { 'drift-dashboard': 'anchored' },
    });

    // Everything after here runs against that known-settled state.
    //
    // The text is back, exactly where the successful burst put it.
    await expect(page.locator('#anchor-drift p')).toHaveText(/^dashboard The first release/);
    // …and so is the anchor. A decoration again, on the moved word.
    await expect(page.locator('#anchor-drift .comment-anchor')).toHaveCount(1);
    await expect(page.locator('#anchor-drift .comment-anchor')).toHaveText('dashboard');
    await expect(page.getByTestId('drift-thread-count')).toHaveText('threads: 1');
    // No deletion event ever fired: removing a thread is the consumer's call.
    await expect(page.getByTestId('event-log')).toBeEmpty();

    // The sidebar drops its orphan marking too — the thread is a normal,
    // placed comment again.
    await page
      .getByTestId('instance-drift')
      .getByRole('button', { name: /comments sidebar/ })
      .click();
    const items = page.locator('#anchor-drift-sidebar .thread-item');
    await expect(items).toHaveCount(1);
    await expect(items.first()).not.toHaveAttribute('data-orphaned', /.*/);
    await expect(page.locator('#anchor-drift-sidebar')).not.toContainText(
      'Quoted text is not in the document',
    );
  });

  test('replacing `value` wholesale re-anchors by quote instead of expanding to the document', async ({
    page,
  }) => {
    // Assigning a new string to `value` produces one step spanning the whole
    // old document. Position mapping across such a step is meaningless — it
    // used to collapse `from` to 0 and push `to` to docSize, which rendered
    // the anchor as one span per text block (two here) and, worse, overwrote
    // the stored quote with the entire document text, destroying the only
    // information a recovery could have used.
    //
    // Now the plugin recognises the shape of that step, keeps quote/prefix/
    // suffix untouched, and defers to a search. Note there IS a visible
    // window of roughly one debounce during which the decoration still sits
    // at the stale positions and highlights the wrong characters; the
    // settled state is what is asserted here.
    await page.getByTestId('drift-replace-value').click();

    await expect(page.locator('#anchor-drift p')).toHaveText(
      'Export actions ship first; the dashboard follows in a later release.',
    );
    await expect(page.locator('#anchor-drift .comment-anchor')).toHaveCount(1);
    await expect(page.locator('#anchor-drift .comment-anchor')).toHaveText('dashboard');
    await expect(page.locator('#anchor-drift h1 .comment-anchor')).toHaveCount(0);

    await expect
      .poll(() => anchorJson(page, 'drift-json'))
      .toEqual({
        from: 46,
        to: 55,
        quote: 'dashboard',
        prefix: 'Release Plan\nExport actions ship first; the ',
        suffix: ' follows in a later release.',
        status: 'anchored',
        originalQuote: 'dashboard',
        lastKnownOffset: 44,
      });
  });
});
