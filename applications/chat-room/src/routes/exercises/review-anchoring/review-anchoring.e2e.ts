import { expect, test } from '@playwright/test';
import { anchorJson, anchorState, ready } from './review-anchoring-test-helpers';

// A fresh page per test. Several of these tests mutate their instance
// irreversibly — deleting the anchored word, moving it, replacing `value` — so
// sharing one page would make the suite order-dependent.
test.beforeEach(async ({ page }) => {
  await ready(page);
});
test.describe('review-anchoring: where a seeded anchor lands', () => {
  test('a correctly-seeded anchor decorates exactly its quoted range', async ({ page }) => {
    // One inline decoration per anchor, each covering only its quote. The
    // span COUNT is the load-bearing part: ProseMirror splits a single
    // decoration into one span per text block it crosses, so an anchor that
    // had been mapped across the whole document would show up here as five
    // spans — one per text block in this fixture — rather than two.
    await expect(page.locator('#anchor-mount h1, #anchor-mount h2, #anchor-mount p')).toHaveCount(
      5,
    );
    await expect(page.locator('#anchor-mount .comment-anchor')).toHaveCount(2);

    // "Release Plan" is PM 1..13 because "# " is markup, not text; the
    // decoration proves the seed named the right range.
    await expect(page.locator('#anchor-mount h1 .comment-anchor')).toHaveText('Release Plan');
    // "dashboard" is PM 44..53 in the same document — 15 (the paragraph's
    // first text position) plus the 29 characters that precede the word.
    await expect(page.locator('#anchor-mount p .comment-anchor')).toHaveText('dashboard');
  });

  test('a document-level anchor decorates nothing and exists only in the sidebar', async ({
    page,
  }) => {
    // Three threads, two decorations. The third has `quote: ''` and a
    // zero-width range, which the plugin's `from >= to` guard skips outright.
    await expect(page.getByTestId('mount-thread-count')).toHaveText('threads: 3');
    await expect(page.locator('#anchor-mount .comment-anchor')).toHaveCount(2);

    await page
      .getByTestId('instance-mount')
      .getByRole('button', { name: /comments sidebar/ })
      .click();

    const items = page.locator('#anchor-mount-sidebar .thread-item');
    await expect(items).toHaveCount(3);

    // A document-level anchor has an empty quote BY DESIGN, so it must never be
    // treated as "quote missing from the document". `anchorMatchesDocument`
    // returns true for an empty quote precisely so these bypass re-anchoring;
    // if that guard were lost they would all be marked orphaned, announced as
    // missing text, and retried on every subsequent edit forever.
    await expect(items.first()).not.toHaveAttribute('data-orphaned', /.*/);
    await expect(page.locator('#anchor-mount-sidebar .thread-orphaned')).toHaveCount(0);
    // Document-level threads sort ahead of the anchored ones and render a
    // label instead of a quote, which is the only place they are visible.
    await expect(items.first()).toContainText('Document comment');
    await expect(items.first()).toContainText('Overall: ship it.');
  });

  test('the same anchor assigned after mount lands exactly where the mount-seeded one did', async ({
    page,
  }) => {
    // This pair used to disagree: a thread present in the INITIAL `threads`
    // prop was mapped through Milkdown's wholesale content-set step and came
    // out spanning the entire document, while the identical thread assigned a
    // tick later produced one span. The asymmetry is gone — both paths now
    // verify the seeded range against the document rather than trusting a
    // meaningless mapping.
    await expect(page.locator('#anchor-late .comment-anchor')).toHaveCount(0);

    await page.getByTestId('seed-late').click();

    await expect(page.locator('#anchor-late .comment-anchor')).toHaveCount(1);
    await expect(page.locator('#anchor-late h1 .comment-anchor')).toHaveText('Release Plan');
    expect(await anchorJson(page, 'late-json')).toEqual({
      from: 1,
      to: 13,
      quote: 'Release Plan',
      prefix: '# ',
      suffix: '\n\nThe first release',
      status: 'anchored',
      originalQuote: 'Release Plan',
      lastKnownOffset: 0,
    });
  });
});

test.describe('review-anchoring: repairing a mis-seeded anchor', () => {
  test('an off-by-one anchor in a paragraph is repaired, and the repair is written back', async ({
    page,
  }) => {
    // Seeded at {from: 45, to: 54} — one position right of "dashboard", so
    // the stored range actually covers "ashboard ". The plugin verifies a
    // seeded range against the document (`textBetween(from, to) === quote`),
    // finds the mismatch, and hands the anchor to the deferred pass, which
    // searches by QUOTE and lands on the real 44..53.
    await expect(page.locator('#anchor-offbyone p .comment-anchor')).toHaveText('dashboard');

    // The repair is not cosmetic: it is published back through the bindable
    // `threads` prop. Note what happens to the context while it is there —
    // the seeded `prefix` was a plausible-looking slice of the MARKDOWN, and
    // it is replaced by real `textBetween` output, where the blank line
    // between blocks is a single "\n" and the heading's "# " does not exist.
    // `suffix` gets the same treatment and stops at 45 characters because the
    // 50-position window it asks for includes node boundaries, which are not
    // text.
    await expect
      .poll(() => anchorJson(page, 'offbyone-dashboard-json'))
      .toEqual({
        from: 44,
        to: 53,
        quote: 'dashboard',
        prefix: 'Release Plan\nThe first release includes a ',
        suffix: ' and export actions.\nChecklist\nFinalize the co',
        status: 'anchored',
        originalQuote: 'dashboard',
        lastKnownOffset: 42,
      });
  });

  test('an off-by-one anchor in a HEADING is repaired too, not corrupted', async ({ page }) => {
    // Same mistake as the paragraph above, one block up: {from: 2, to: 14}
    // instead of {from: 1, to: 13}. This case used to be permanent, and the
    // asymmetry with the paragraph is what gave the mechanism away.
    //
    // Marking an anchor for re-anchoring only schedules work 300ms out. Any
    // transaction overlapping the WRONG stored range that lands first used to
    // take the plugin's "the edit was inside this anchor" branch, which
    // rewrote its copy of `quote` to whatever text sat at that range. The
    // anchor then looked internally consistent, the deferred pass's
    // `textBetween(from, to) === quote` check passed, and re-anchoring never
    // ran. Headings get such a transaction for free — Milkdown assigns every
    // heading a slug `id` via `setNodeMarkup`, whose step spans the whole
    // node — and paragraphs get no equivalent. Hence one repaired and one not.
    //
    // cinder#1275 gates that branch on the anchor having verifiably described
    // its own text BEFORE the transaction, so an anchor that never checked out
    // keeps its quote and is relocated by search instead.
    const headingAnchor = page.locator('#anchor-offbyone h1 .comment-anchor');
    await expect(headingAnchor).toHaveText('Release Plan');
    // The heading still gets its Milkdown slug — the trigger is unchanged;
    // what changed is that it no longer cements the anchor.
    await expect(page.locator('#anchor-offbyone h1')).toHaveAttribute('id', 'release-plan');

    // Settled, and settled the right way. Both anchors on this instance are
    // mis-seeded, so the mount sync raises `needsReanchor`; the deferred pass
    // lowers it again when it finishes. Polling for the flag to come back down
    // waits for exactly that pass rather than for a duration, and the statuses
    // alongside it are what stop the wait from being satisfied by a FAILED
    // repair — an anchor the pass could not place also reports
    // `needsReanchor: false`, and would show up here as `orphaned`.
    await expect
      .poll(() => anchorState(page, 'offbyone'))
      .toEqual({
        needsReanchor: false,
        statuses: { 'offbyone-title': 'anchored', 'offbyone-dashboard': 'anchored' },
      });
    await expect(headingAnchor).toHaveText('Release Plan');

    // Document and sidebar now agree. Previously the sidebar quoted the prop
    // ("Release Plan") while the document highlighted "elease Plan", and
    // nothing in the UI disagreed with itself loudly enough to be noticed.
    await page
      .getByTestId('instance-offbyone')
      .getByRole('button', { name: /comments sidebar/ })
      .click();
    await expect(page.locator('#anchor-offbyone-sidebar .thread-quote').first()).toHaveText(
      'Release Plan',
    );
  });
});

test.describe('review-anchoring: anchor states in the document', () => {
  test('hovering an anchor marks it, and leaving it clears the mark', async ({ page }) => {
    const anchor = page.locator('#anchor-mount p .comment-anchor');
    await expect(anchor).toHaveClass('comment-anchor');

    await anchor.hover();
    await expect(anchor).toHaveClass(/comment-anchor--hovered/);

    // Moving the pointer off the span is enough; the plugin listens for
    // mouseout and mouseleave on the editor DOM, not for a click elsewhere.
    await page.mouse.move(0, 0);
    await expect(anchor).not.toHaveClass(/comment-anchor--hovered/);
  });

  test('PINNED KNOWN BUG: the active thread is never visually distinguished in the document', async ({
    page,
  }) => {
    // The decoration plugin has a `comment-anchor--active` class and a
    // `set-active` meta transaction for switching it on. Nothing in the
    // component ever dispatches that meta, so the class is unreachable: the
    // thread you are reading looks exactly like every other thread.
    await page
      .getByTestId('instance-mount')
      .getByRole('button', { name: /comments sidebar/ })
      .click();

    const anchor = page.locator('#anchor-mount p .comment-anchor');
    await anchor.click();

    // The component definitely knows which thread is active — the sidebar
    // marks it current — which is what makes the missing decoration state a
    // gap rather than an unimplemented feature.
    const activeItem = page.locator('#anchor-mount-sidebar .thread-item[aria-current="true"]');
    await expect(activeItem).toHaveCount(1);
    await expect(activeItem).toContainText('dashboard');

    // …and the document shows nothing. Note this is not an assertion about a
    // class that merely happens to be absent: the hover test above proves the
    // same `computeDecorations` call DOES emit its other state class, from
    // the same plugin state, through the same code path. Only the meta that
    // would set `activeThreadId` inside the plugin is never sent.
    await expect(page.locator('#anchor-mount .comment-anchor--active')).toHaveCount(0);
    // Asserted as a non-match rather than an exact class list, because the
    // click leaves the pointer on the span and therefore leaves
    // `comment-anchor--hovered` behind.
    await expect(anchor).not.toHaveClass(/comment-anchor--active/);
  });
});
