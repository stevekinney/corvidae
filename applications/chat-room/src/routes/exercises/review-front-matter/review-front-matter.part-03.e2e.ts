import { expect, test } from '@playwright/test';
import type { Page } from './review-front-matter-test-helpers';
import { openFixture } from './review-front-matter-test-helpers';

test.describe('review front matter: anchors across a front-matter edit', () => {
  let page: Page;

  // Seeded and expected anchor coordinates. `bodyOffset` is the character
  // length of the front-matter block including both delimiters: 97 for
  // FULL_DOCUMENT, 95 after the `title` edit collapses `tags` to flow style and
  // alphabetizes the keys (two lines' worth of characters shorter).
  const BODY_OFFSET_BEFORE = 97;
  const BODY_OFFSET_AFTER = 95;
  const SHIFT = BODY_OFFSET_AFTER - BODY_OFFSET_BEFORE;

  // The seeded anchor: ProseMirror 1..13 for "Release Plan" inside the BODY
  // document ("# " is markup, not text), plus `bodyOffset` because the
  // component stores anchors in document coordinates.
  const FROM_BEFORE = 1 + BODY_OFFSET_BEFORE;
  const TO_BEFORE = 13 + BODY_OFFSET_BEFORE;
  // `lastKnownOffset` and `originalPosition.offset` are `textBetween()`-style
  // offsets (0 for a quote at the start of the body), not ProseMirror
  // positions — a second coordinate space inside the same object — and they
  // get the same `bodyOffset` added to them.
  const OFFSET_BEFORE = 0 + BODY_OFFSET_BEFORE;

  test.beforeAll(async ({ browser }) => {
    page = await openFixture(browser);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test('at rest, a seeded anchor stays exactly as given and decorates only its quote', async () => {
    await expect(page.getByTestId('fm-anchors-body-offset')).toHaveText(String(BODY_OFFSET_BEFORE));
    await expect(page.getByTestId('fm-anchor-from')).toHaveText(String(FROM_BEFORE));
    await expect(page.getByTestId('fm-anchor-to')).toHaveText(String(TO_BEFORE));
    await expect(page.getByTestId('fm-anchor-last-known-offset')).toHaveText(String(OFFSET_BEFORE));
    await expect(page.getByTestId('fm-anchor-original-offset')).toHaveText(String(OFFSET_BEFORE));

    // A correct anchor decorates exactly its quoted range — one inline
    // decoration wrapping the twelve characters of the heading text, not the
    // whole document.
    const decoration = page.locator('.comment-anchor[data-thread-id="thread-fm-title"]');
    await expect(decoration).toHaveCount(1);
    await expect(decoration).toHaveText('Release Plan');
  });

  test('a front-matter edit shifts every text-anchor coordinate by exactly the body-offset delta', async () => {
    await page.locator('#fm-anchors-front-matter-title').fill('Release Plan v2');

    // The shorter serialized block is the whole cause: the body did not move
    // relative to itself, only relative to the start of the document.
    await expect(page.getByTestId('fm-anchors-body-offset')).toHaveText(String(BODY_OFFSET_AFTER));
    await expect(page.getByTestId('fm-anchor-from')).toHaveText(String(FROM_BEFORE + SHIFT));
    await expect(page.getByTestId('fm-anchor-to')).toHaveText(String(TO_BEFORE + SHIFT));
    await expect(page.getByTestId('fm-anchor-last-known-offset')).toHaveText(
      String(OFFSET_BEFORE + SHIFT),
    );
    await expect(page.getByTestId('fm-anchor-original-offset')).toHaveText(
      String(OFFSET_BEFORE + SHIFT),
    );

    // The quote and its decoration are untouched — the anchor still points at
    // the same twelve characters, just numbered differently.
    await expect(page.getByTestId('fm-anchor-quote')).toHaveText('Release Plan');
    const decoration = page.locator('.comment-anchor[data-thread-id="thread-fm-title"]');
    await expect(decoration).toHaveCount(1);
    await expect(decoration).toHaveText('Release Plan');
  });

  test('`originalPosition` line and column are recomputed from the new document text', async () => {
    // Unlike the offsets, line/column are not shifted arithmetically: they are
    // re-derived by walking the NEW document to the remapped offset. The block
    // lost two lines (`tags:` plus its two sequence items became one flow
    // line), so the body's first line moves from 11 to 9. Column is unchanged
    // because the offset still lands at the start of a line.
    await expect(page.getByTestId('fm-anchor-original-line')).toHaveText('9');
    await expect(page.getByTestId('fm-anchor-original-column')).toHaveText('1');
  });

  test('document-type anchors are returned untouched, and no thread is dropped', async () => {
    // `offsetAnchor` short-circuits on `type: 'document'`, so a document-level
    // thread keeps its 0/0 coordinates through a remap that moved everything
    // else.
    await expect(page.getByTestId('fm-document-anchor-from')).toHaveText('0');
    await expect(page.getByTestId('fm-document-anchor-to')).toHaveText('0');
    await expect(page.getByTestId('fm-anchors-thread-count')).toHaveText('2');
  });
});
