import { expect, test } from '@playwright/test';
import {
  boxesOverlap,
  desktopViewport,
  expectBoxInsideViewport,
  expectSelectionPopoverPlacement,
  openPage,
  requireBox,
  selectTextInExample,
  waitForSelectionPopoverClearOfSelection,
  waitForSelectionPopoverPlacement,
} from './selection-popover-positioning-helpers.ts';

test.use({ viewport: { width: desktopViewport.width, height: desktopViewport.height } });

test('selected text popover and composer anchor without overlapping the selection', async ({
  page,
}) => {
  await openPage(page);
  const selection = await selectTextInExample(page, 'appears near highlighted text');

  const popover = page.locator('#basic-selection-popover');
  await expect(popover).toHaveAttribute('data-cinder-position-ready', 'true');
  await expect
    .poll(() => popover.evaluate((element) => element.parentElement === document.body))
    .toBe(true);

  const collapsedBox = requireBox(await popover.boundingBox(), 'Collapsed selection popover');
  expectSelectionPopoverPlacement(
    selection.anchorBox,
    collapsedBox,
    await popover.getAttribute('data-cinder-placement'),
  );
  expectBoxInsideViewport(collapsedBox, desktopViewport);

  await page.getByRole('button', { name: 'Add comment' }).first().click();
  await expect(page.getByRole('textbox', { name: 'Comment text' })).toBeVisible();
  await expect(popover).toHaveAttribute('data-cinder-position-ready', 'true');
  await waitForSelectionPopoverClearOfSelection(
    page,
    '#basic-selection-popover',
    selection.anchorBox,
  );

  const expandedBox = requireBox(await popover.boundingBox(), 'Expanded selection popover');
  expect(boxesOverlap(selection.anchorBox, expandedBox)).toBe(false);
  expectBoxInsideViewport(expandedBox, desktopViewport);
});

test('selection popover dismisses when the viewport scrolls', async ({ page }) => {
  await openPage(page);
  await selectTextInExample(page, 'appears near highlighted text');
  const popover = page.locator('#basic-selection-popover');
  await expect(popover).toHaveAttribute('data-cinder-position-ready', 'true');

  const initialScrollY = await page.evaluate(() => window.scrollY);
  await page.mouse.wheel(0, 300);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(initialScrollY);
  await expect(popover).toHaveAttribute('data-cinder-position-ready', 'false');
});

test('selection popover dismisses when a nested scroll container scrolls', async ({ page }) => {
  await openPage(page);
  await page.evaluate(() => {
    const article = document.querySelector<HTMLElement>('article');
    if (!article?.parentElement) {
      throw new Error('Selection popover example must render an article.');
    }

    const scrollContainer = document.createElement('div');
    scrollContainer.dataset['testid'] = 'nested-selection-scroll-container';
    scrollContainer.style.height = '8rem';
    scrollContainer.style.overflow = 'auto';
    article.style.minHeight = '30rem';
    article.parentElement.insertBefore(scrollContainer, article);
    scrollContainer.append(article);
  });

  await selectTextInExample(page, 'appears near highlighted text');
  const popover = page.locator('#basic-selection-popover');
  await expect(popover).toHaveAttribute('data-cinder-position-ready', 'true');

  const scrollContainer = page.getByTestId('nested-selection-scroll-container');
  await scrollContainer.evaluate((element) => element.scrollBy(0, 100));
  await expect
    .poll(() => scrollContainer.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await expect(popover).toHaveAttribute('data-cinder-position-ready', 'false');
});

test('multi-line selections anchor to the first visual client rect', async ({ page }) => {
  await openPage(page);
  const selection = await selectTextInExample(
    page,
    'Clicking the comment icon expands the composer. Submit with the send button',
    { constrainClosestArticleWidth: '12rem' },
  );

  expect(selection.clientRectCount).toBeGreaterThan(1);
  expect(selection.boundingBox.height).toBeGreaterThan(selection.anchorBox.height * 1.5);

  const popover = page.locator('#basic-selection-popover');
  await expect(popover).toHaveAttribute('data-cinder-position-ready', 'true');
  await waitForSelectionPopoverPlacement(page, '#basic-selection-popover', selection.anchorBox);

  const popoverBox = requireBox(await popover.boundingBox(), 'Multi-line selection popover');
  expectSelectionPopoverPlacement(
    selection.anchorBox,
    popoverBox,
    await popover.getAttribute('data-cinder-placement'),
  );
  expectBoxInsideViewport(popoverBox, desktopViewport);
});

test('external trigger derives its anchor from the visible marked phrase', async ({ page }) => {
  await openPage(page);
  const trigger = page.getByRole('button', { name: 'Open popover' });
  await trigger.scrollIntoViewIfNeeded();

  const anchor = page.getByTestId('external-trigger-anchor');
  const anchorBox = await anchor.boundingBox();
  expect(anchorBox).not.toBeNull();

  await trigger.click();

  const popover = page.locator('#toggled-selection-popover');
  await expect(popover).toHaveAttribute('data-cinder-position-ready', 'true');
  const popoverBox = requireBox(await popover.boundingBox(), 'External trigger selection popover');

  expectSelectionPopoverPlacement(
    requireBox(anchorBox, 'External trigger anchor'),
    popoverBox,
    await popover.getAttribute('data-cinder-placement'),
  );
  expectBoxInsideViewport(popoverBox, desktopViewport);
});

test('viewport edge anchors shift or flip inside the viewport', async ({ page }) => {
  await openPage(page);
  const trigger = page.getByRole('button', { name: 'Show clamping test popovers' });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();

  for (const selector of [
    '#viewport-clamp-negative-x',
    '#viewport-clamp-overflow-x',
    '#viewport-clamp-negative-y',
  ]) {
    const popover = page.locator(selector);
    await expect(popover).toHaveAttribute('data-cinder-position-ready', 'true');
    const popoverBox = requireBox(await popover.boundingBox(), `${selector} popover`);
    expectBoxInsideViewport(popoverBox, desktopViewport);
  }
});

test('existing commented selection story renders and switches persisted anchors', async ({
  page,
}) => {
  await openPage(page);
  const anchors = page.getByTestId('existing-comment-anchor');

  await anchors.first().scrollIntoViewIfNeeded();
  await expect(anchors).toHaveCount(2);
  await expect(anchors.first()).toHaveAttribute('data-active', 'true');
  await expect(anchors.first()).toHaveAttribute('aria-current', 'true');
  await expect(anchors.first()).toHaveAttribute('aria-controls', 'existing-comment-panel');
  await expect(page.getByText('This phrase already has a persisted comment.')).toBeVisible();

  await anchors.nth(1).click();

  await expect(anchors.first()).toHaveAttribute('data-active', 'false');
  await expect(anchors.first()).not.toHaveAttribute('aria-current', 'true');
  await expect(anchors.nth(1)).toHaveAttribute('data-active', 'true');
  await expect(anchors.nth(1)).toHaveAttribute('aria-current', 'true');
  await expect(page.getByText('ReviewEditor uses commentary anchor decorations')).toBeVisible();
});
