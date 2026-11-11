import { expect, test, type Page } from '@playwright/test';
import { fixtureRoute } from './layout-fixture.ts';

const DECISION_DECK_ROUTE = fixtureRoute('decision-deck');
const TOP_CARD = '#example-mount-basic [data-cinder-decision-card][data-depth="0"]';
const TOP_TITLE = `${TOP_CARD} .cinder-decision-card__title`;
const UNDO_TEXT = '#example-mount-basic .cinder-decision-deck__undo-text';

// Presses on the middle of the top card, then drags the mouse sideways by `distance` pixels.
async function dragTopCard(page: Page, distance: number, release: boolean): Promise<void> {
  const box = await page.locator(TOP_CARD).boundingBox();
  if (!box) throw new Error('The top card has no layout box.');
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + distance, startY, { steps: 10 });
  if (release) await page.mouse.up();
}

test.describe('DecisionDeck drag threshold', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(DECISION_DECK_ROUTE, { waitUntil: 'load' });
    await page.locator(TOP_CARD).scrollIntoViewIfNeeded();
  });

  test('the card only pans vertically, so a horizontal drag belongs to the deck', async ({
    page,
  }) => {
    await expect(page.locator(TOP_CARD)).toHaveCSS('touch-action', 'pan-y');
  });

  test('a drag moves the card and fades the accept stamp in before the threshold', async ({
    page,
  }) => {
    await dragTopCard(page, 100, false);

    await expect(page.locator(TOP_CARD)).toHaveAttribute('data-dragging', '');
    const offset = await page.locator(TOP_CARD).evaluate((element) => {
      return new DOMMatrixReadOnly(getComputedStyle(element).transform).m41;
    });
    expect(Math.round(offset)).toBe(100);
    await expect(page.locator(`${TOP_CARD} [data-stamp="accept"]`)).toHaveCSS('opacity', /^0\.9/);
    await expect(page.locator(`${TOP_CARD} [data-stamp="reject"]`)).toHaveCSS('opacity', '0');

    await page.mouse.up();
  });

  test('a release short of 110px springs back and decides nothing', async ({ page }) => {
    await dragTopCard(page, 100, true);

    await expect(page.locator(TOP_TITLE)).toHaveText('Archive receipts');
    await expect(page.locator(TOP_CARD)).not.toHaveAttribute('data-dragging', '');
    await expect(page.locator(TOP_CARD)).toHaveCSS('transform', 'none');
    await expect(page.locator('#example-mount-basic .cinder-decision-deck__undo')).toHaveCount(0);
  });

  test('a release past 110px to the right accepts, and Undo brings the card back', async ({
    page,
  }) => {
    await dragTopCard(page, 120, true);

    await expect(page.locator(TOP_TITLE)).toHaveText('Label the weekly digest');
    await expect(page.locator(UNDO_TEXT)).toHaveText('Accepted: Archive receipts');

    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.locator(TOP_TITLE)).toHaveText('Archive receipts');
    await expect(page.locator(UNDO_TEXT)).toHaveCount(0);
  });

  test('a release past 110px to the left rejects', async ({ page }) => {
    await dragTopCard(page, -120, true);

    await expect(page.locator(TOP_TITLE)).toHaveText('Label the weekly digest');
    await expect(page.locator(UNDO_TEXT)).toHaveText('Rejected: Archive receipts');
  });

  test('the buttons and the arrow keys make the same decisions as a swipe', async ({ page }) => {
    await page.getByRole('button', { name: 'Reject' }).click();
    await expect(page.locator(UNDO_TEXT)).toHaveText('Rejected: Archive receipts');

    await page.locator(TOP_CARD).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator(UNDO_TEXT)).toHaveText('Accepted: Label the weekly digest');
    await expect(page.locator(TOP_CARD)).toBeFocused();

    await page.keyboard.press('ArrowDown');
    await expect(
      page.locator('#example-mount-basic .cinder-decision-deck__empty-title'),
    ).toHaveText('All caught up');
    await expect(page.locator('#example-mount-basic .cinder-decision-deck__empty')).toBeFocused();
  });
});

test.describe('DecisionDeck spring and reduced motion', () => {
  test('a released card eases back with a transition', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto(DECISION_DECK_ROUTE, { waitUntil: 'load' });

    await expect(page.locator(TOP_CARD)).not.toHaveCSS('transition-duration', '0s');
  });

  test('reduced motion skips the spring', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(DECISION_DECK_ROUTE, { waitUntil: 'load' });

    // `foundation.css` wins the cascade under reduced motion with `transition-duration: 0.01ms
    // !important`, which the browser reports as `1e-05s`, so the card's own `transition: none`
    // never reads back as `0s`. What must hold is that no spring plays: every duration is under a
    // millisecond.
    await expect
      .poll(() =>
        page.locator(TOP_CARD).evaluate((element) => {
          const parts = getComputedStyle(element).transitionDuration.split(',');
          return Math.max(...parts.map((part) => Number.parseFloat(part)));
        }),
      )
      .toBeLessThan(0.001);
  });
});
