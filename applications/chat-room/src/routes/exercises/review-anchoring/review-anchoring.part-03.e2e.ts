import { expect, test } from '@playwright/test';
import { anchorJson, ready } from './review-anchoring-test-helpers';

// A fresh page per test. Several of these tests mutate their instance
// irreversibly — deleting the anchored word, moving it, replacing `value` — so
// sharing one page would make the suite order-dependent.
test.beforeEach(async ({ page }) => {
  await ready(page);
});
test.describe('review-anchoring: ambiguity', () => {
  test('re-anchoring can move a thread onto a DIFFERENT occurrence of its quote', async ({
    page,
  }) => {
    const paragraphs = page.locator('#anchor-ambiguous p');
    // The thread starts on the second paragraph's "widget".
    await expect(paragraphs.nth(1).locator('.comment-anchor')).toHaveText('widget');
    await expect(paragraphs.first().locator('.comment-anchor')).toHaveCount(0);

    // Cut that occurrence and paste it at the end of its own paragraph. Two
    // exact matches now exist, and scoring has to pick one: context
    // similarity at 0.7, proximity to `lastKnownOffset` at 0.3. The moved
    // copy sits at the end of the document, so its suffix context scores
    // zero, which is enough to lose to a word in a paragraph the user never
    // touched.
    await page.getByTestId('ambiguous-move').click();

    await expect(paragraphs.nth(1)).toHaveText(/widget$/);
    await expect(page.locator('#anchor-ambiguous .comment-anchor')).toHaveCount(1);
    // The comment has silently relocated to the FIRST paragraph.
    await expect(paragraphs.first().locator('.comment-anchor')).toHaveText('widget');
    await expect(paragraphs.nth(1).locator('.comment-anchor')).toHaveCount(0);

    // No deletion event: as far as the app is concerned the thread is fine.
    await expect(page.getByTestId('ambiguous-thread-count')).toHaveText('threads: 1');
    await expect(page.getByTestId('event-log')).toBeEmpty();

    await expect
      .poll(() => anchorJson(page, 'ambiguous-json'))
      .toEqual({
        from: 7,
        to: 13,
        quote: 'widget',
        prefix: 'Alpha ',
        suffix: ' beta.\nGamma  delta. widget',
        status: 'anchored',
        originalQuote: 'widget',
        lastKnownOffset: 6,
      });
  });
});

test.describe('review-anchoring: the re-anchoring functions, driven directly', () => {
  // `reanchorQuote`, `findAllOccurrences`, `fuzzyReanchor` and
  // `scoreContextMatch` are plain exports from `@repo/editor/comments`,
  // which is the only way to see the confidence score the component computes
  // and then discards.

  test('`found` is decided by exact-substring existence alone, with no threshold', async ({
    page,
  }) => {
    // Perfect context: the quote is there and the surroundings match exactly.
    await expect(page.getByTestId('reanchor-perfect')).toHaveText(
      'found=true from=42 confidence=1.000',
    );

    // Same quote, same position, context drawn from an alphabet the document
    // does not contain. Confidence bottoms out at exactly zero and `found` is
    // still true — no threshold sits between the two. A consumer sees only
    // `found`, so this is indistinguishable from the case above.
    await expect(page.getByTestId('reanchor-garbage')).toHaveText(
      'found=true from=42 confidence=0.000',
    );
  });

  test('a `found: false` result can carry a HIGHER confidence than a `found: true` one', async ({
    page,
  }) => {
    // When the quote is absent entirely, `reanchorQuote` falls through to
    // `fuzzyReanchor`, which hunts for the junction where the text used to be
    // and reports how sure it is about THAT. 0.636 here — against 0.000 for
    // the garbage-context match that returned `found: true`. The two fields
    // answer different questions and neither one alone means "this anchor is
    // good".
    await expect(page.getByTestId('reanchor-absent')).toHaveText(
      'found=false from=41 confidence=0.636',
    );
  });

  test('an empty quote finds nothing, which is what a document-level thread is', async ({
    page,
  }) => {
    // `findAllOccurrences` short-circuits on an empty quote, and
    // `fuzzyReanchor` skips its junction search without a prefix, so every
    // document-level anchor round-tripped through this function reports
    // `found: false` — the shape that drops them on a state restore.
    await expect(page.getByTestId('reanchor-empty')).toHaveText(
      'found=false from=0 confidence=0.000',
    );
    await expect(page.getByTestId('occurrences-empty')).toHaveText('0');
  });

  test('overlapping occurrences all count', async ({ page }) => {
    // The scan restarts one character past each hit rather than past the
    // whole match, so "aa" occurs three times in "aaaa", not twice.
    await expect(page.getByTestId('occurrences-overlapping')).toHaveText(
      '3: [{"start":0,"end":2},{"start":1,"end":3},{"start":2,"end":4}]',
    );
  });

  test('the ambiguous case scores out to the earlier occurrence, matching the live editor', async ({
    page,
  }) => {
    // The same inputs the live instance produces after its move, run as pure
    // arithmetic: offset 6 is the FIRST paragraph's "widget". The live
    // re-anchor and the pure function agree, which is what makes the live
    // outcome a scoring result rather than an accident of timing.
    await expect(page.getByTestId('reanchor-ambiguous')).toHaveText(
      'found=true from=6 confidence=0.606',
    );
  });
});
