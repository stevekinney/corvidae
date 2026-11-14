import { expect, test } from '@playwright/test';
import { fixtureRoute } from './layout-fixture.ts';

const CARD_ROUTE = fixtureRoute('card');

test.describe('Card padding', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(CARD_ROUTE, { waitUntil: 'load' });
  });
  test('padding="none" flushes only the body', async ({ page }) => {
    const body = page.locator(".cinder-card__body[data-cinder-padding='none']").first();
    const card = body.locator('..');
    const header = card.locator(':scope > .cinder-card__header');
    const footer = card.locator(':scope > .cinder-card__footer');
    await expect(card).toBeVisible();
    await expect(header).toHaveCSS('padding-top', '12px');
    await expect(header).toHaveCSS('padding-right', '16px');
    await expect(header).toHaveCSS('padding-bottom', '12px');
    await expect(header).toHaveCSS('padding-left', '16px');
    // The divider under the header is opt-in (`headerDivider`, COR-1821); this card does not opt in.
    await expect(header).toHaveCSS('border-bottom-width', '0px');
    await expect(body).toHaveCSS('padding-top', '0px');
    await expect(body).toHaveCSS('padding-right', '0px');
    await expect(body).toHaveCSS('padding-bottom', '0px');
    await expect(body).toHaveCSS('padding-left', '0px');
    // Under a flush body the footer keeps the card's padding on every side, so its action never
    // touches the content (a padded body's footer has no top padding of its own).
    await expect(footer).toHaveCSS('padding-top', '16px');
    await expect(footer).toHaveCSS('padding-right', '16px');
    await expect(footer).toHaveCSS('padding-bottom', '16px');
    await expect(footer).toHaveCSS('padding-left', '16px');
  });
  test('the flush-body example has no horizontal overflow', async ({ page }) => {
    const body = page.locator(".cinder-card__body[data-cinder-padding='none']").first();
    const card = body.locator('..');
    const preview = page.locator('#example-mount-flush-body');
    const overflow = await card.evaluate((element) => {
      const previewElement = element.closest('.example-preview') ?? element.parentElement;
      if (!(previewElement instanceof HTMLElement)) throw new Error('Missing preview');
      const cardRectangle = element.getBoundingClientRect();
      const previewRectangle = previewElement.getBoundingClientRect();
      return {
        cardClientWidth: element.clientWidth,
        cardScrollWidth: element.scrollWidth,
        cardOverflow: getComputedStyle(element).overflow,
        cardBoxSizing: getComputedStyle(element).boxSizing,
        cardRight: cardRectangle.right,
        previewClientWidth: previewElement.clientWidth,
        previewScrollWidth: previewElement.scrollWidth,
        previewRight: previewRectangle.right,
      };
    });
    await expect(preview).toBeVisible();
    expect(overflow.cardOverflow).toBe('hidden');
    expect(overflow.cardBoxSizing).toBe('border-box');
    expect(overflow.cardScrollWidth).toBeLessThanOrEqual(overflow.cardClientWidth);
    expect(overflow.previewScrollWidth).toBeLessThanOrEqual(overflow.previewClientWidth);
    expect(overflow.cardRight).toBeLessThanOrEqual(overflow.previewRight);
  });
  test('ApprovalCard draws its heading as the first row of its body, on the card fill', async ({
    page,
  }) => {
    const approvalCard = page.locator('.cinder-approval-card').first();
    const body = approvalCard.locator('.cinder-approval-card__body');
    const ownedHeader = body.locator(':scope > .cinder-approval-card__header');
    await expect(approvalCard).toBeVisible();
    await expect(approvalCard.locator('.cinder-card__header')).toHaveCount(0);
    // One padding layer, the body's; the heading adds none and paints no band of its own.
    await expect(ownedHeader).toHaveCSS('padding-top', '0px');
    await expect(ownedHeader).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(ownedHeader).toHaveCSS('border-bottom-width', '0px');
    await expect(body).toHaveCSS('padding-top', '12px');
    await expect(body).toHaveCSS('padding-left', '12px');
  });
});
