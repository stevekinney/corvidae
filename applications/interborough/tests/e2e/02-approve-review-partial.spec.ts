/**
 * Persona flow (b): approve-a-review-with-partial-sections (plan §11.4).
 *
 * reviews → partial section decisions → submit → decided.
 *
 * Targets `fixtures/reviews.ts`'s `content-review` specimens — both of the
 * currently-pending ones carry `artifact.sections` (headline/body/
 * callToAction) regardless of their own `allowPartial` value (section
 * rendering is driven purely by artifact shape —
 * `review-domain.ts`'s `extractReviewSections`), so this locates any
 * pending review whose type badge reads "content" rather than a specific
 * document title, which the row itself never renders.
 */
import { E2E_BASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

const REVIEWER = 'e2e-operator';
const FEEDBACK = 'Tighten the call to action; the rest reads well.';

test('operator decides a sectioned review with a mixed partial outcome', async ({
  page,
  request,
  checkA11y,
}) => {
  await page.goto('/reviews');
  // See `01-debug-failed-workflow.spec.ts`'s module doc for why the first
  // axe check on every spec is gated behind real content, not the boot
  // skeleton `page.goto()`'s `load` event resolves under.
  await expect(page.getByRole('heading', { level: 2, name: 'Engine reviews' })).toBeVisible();
  await checkA11y('reviews inbox');

  // The engine's pending reviews are in their own section, each with its own form. The sectioned
  // ones are `content` reviews; the first of them is decided here.
  const review = page
    .locator('.weft-review-detail')
    .filter({ has: page.getByText('Section decisions') })
    .first();
  await expect(review).toBeVisible();
  const reviewId = await review.getByRole('link').first().getAttribute('href');

  await review
    .getByRole('radiogroup', { name: 'Headline decision' })
    .getByRole('radio', { name: 'Approve' })
    .click();
  await review
    .getByRole('radiogroup', { name: 'Body decision' })
    .getByRole('radio', { name: 'Approve' })
    .click();
  await review
    .getByRole('radiogroup', { name: 'Call to action decision' })
    .getByRole('radio', { name: 'Reject' })
    .click();

  // A mixed section outcome auto-suggests "Changes" (needs-changes) —
  // `review-domain.ts`'s `suggestOverallDecision` — which is exactly the
  // partial-decision scenario this flow exercises, so the overall picker
  // is left on its suggestion rather than touched.
  await expect(
    review.getByRole('radiogroup', { name: 'Overall decision' }).getByRole('radio', {
      name: 'Changes',
      checked: true,
    }),
  ).toBeVisible();
  await expect(review.getByText('Suggested from sections')).toBeVisible();

  await review.getByRole('textbox', { name: 'Reviewer' }).fill(REVIEWER);
  await review.getByRole('textbox', { name: /^Feedback/ }).fill(FEEDBACK);
  await checkA11y('reviews inbox — decision form (partial sections)');

  await review.getByRole('button', { name: 'Submit decision' }).click();

  // The page lists only what waits on someone, so the decided review leaves it. The engine has it
  // as decided, with the reviewer and the outcome the form sent.
  await expect(page.locator(`.weft-review-detail a[href="${reviewId ?? ''}"]`)).toHaveCount(0);
  const decided = await request.get(`${E2E_BASE_URL}/v1/reviews`, {
    params: { status: 'completed' },
  });
  const entries = ((await decided.json()) as { items: Array<Record<string, unknown>> }).items;
  expect(entries.find((entry) => entry['reviewer'] === REVIEWER)).toMatchObject({
    decision: 'needs-changes',
  });
  await checkA11y('reviews — after the decision');
});
