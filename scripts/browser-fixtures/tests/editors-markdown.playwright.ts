import type { Locator, Page } from '@playwright/test';
import { openTouchPage, TOUCH_TARGET_MIN } from './editors-complex-support.ts';
import { expect, test } from './review-editor-browser-errors.ts';

const MARKDOWN_EDITOR_ROUTE = '/page/markdown-editor?snapshot=1';

// The LinkPopover close button is pointer-aware (COR-463): 28px under a fine pointer so the
// header stays within its 40px density budget, and the shared 44px touch target
// (`--cinder-touch-target-min`) under a coarse pointer. `markdown-editor-toolbar.playwright.ts`
// pins the exact fine-pointer size; these are floors for both pointer types.
const CLOSE_BUTTON_FINE_POINTER_MIN = 28;
const CLOSE_BUTTON_COARSE_POINTER_MIN = TOUCH_TARGET_MIN;

/**
 * Reveals the Link trigger on an already-loaded MarkdownEditor page, opening the
 * "More formatting" popover first when the toolbar has overflowed it out of line.
 */
async function revealLinkTrigger(page: Page): Promise<Locator> {
  // CIN-130 made the toolbar's overflow width-driven rather than a fixed split, so
  // the Link button sits inline whenever the toolbar has room for it and only moves
  // into the "More formatting" popover once it does not. These tests care about the
  // LINK popover, not about which side of that split its trigger is on, so reach the
  // trigger wherever it currently lives. Asserting the overflow button exists would
  // pin a viewport-dependent layout detail these tests do not own.
  // `.first()`: this page mounts more than one MarkdownEditor, so asserting on the
  // bare locator is a strict-mode violation. The previous wait dodged that by only
  // ever calling `.first()` on descendants; scoping the root itself is both narrower
  // and deterministic about which editor the rest of the test measures.
  const editor = page.locator('.markdown-editor-wrapper[data-ready="true"]').first();
  await expect(editor).toBeVisible();

  const inlineLinkButton = editor.locator('[data-testid="toolbar-link"]').first();
  const moreFormattingButton = editor
    .locator('button[aria-label="More formatting"]:not(:disabled)')
    .first();

  // The toolbar's overflow pass is ResizeObserver-driven, so the Link trigger can be
  // in NEITHER place for a frame or two after the wrapper reports ready. Wait for it
  // to land on one side of the split before sampling which side that was: a bare
  // isVisible() here races the pass and takes the overflow branch by accident.
  //
  // This waits on the settling condition itself rather than on a fixed duration --
  // two 10-second waits stood here before and were masking exactly this race, which
  // is why the branch below could pick wrong while both waits still passed.
  //
  // Asserted with an explicit poll rather than `a.or(b).first()`: a merged locator
  // resolves in DOM order, so `.first()` can settle on a match that exists but is
  // hidden -- the inline Link button rendered while overflowing, say -- and report
  // "visible" for the wrong one. Checking both flags and OR-ing them cannot.
  await expect(async () => {
    const [inlineVisible, overflowVisible] = await Promise.all([
      inlineLinkButton.isVisible(),
      moreFormattingButton.isVisible(),
    ]);
    expect(inlineVisible || overflowVisible).toBe(true);
  }).toPass();

  let linkButton = inlineLinkButton;

  if (!(await inlineLinkButton.isVisible())) {
    await moreFormattingButton.click();
    const formattingPopover = page.getByRole('dialog', { name: 'More formatting' });
    await expect(formattingPopover).toBeVisible();
    linkButton = formattingPopover.locator('[data-testid="toolbar-link"]').first();
  }

  await expect(linkButton).toBeVisible();
  return linkButton;
}

async function primaryPointerIsCoarse(page: Page): Promise<boolean> {
  return page.evaluate(() => window.matchMedia('(pointer: coarse)').matches);
}

test.describe('markdown link popover', () => {
  test('link popover anchors to its trigger and the fine-pointer close button keeps its 28px target', async ({
    page,
  }) => {
    // Use a desktop viewport wide enough that the 320px popover fits beside its
    // trigger, so bottom-start alignment holds and is meaningful to assert. On a
    // narrow viewport Floating UI's shift() would (correctly) pull the popover
    // away from the trigger to stay on-screen, which is exercised implicitly by
    // the viewport-containment checks below.
    await page.goto(MARKDOWN_EDITOR_ROUTE, { waitUntil: 'load' });
    await page.waitForSelector('#app > *', { state: 'visible', timeout: 20_000 });

    const linkButton = await revealLinkTrigger(page);
    const triggerBox = await linkButton.boundingBox();
    expect(triggerBox).not.toBeNull();
    const trigger = triggerBox!;

    await linkButton.click();

    const linkPopover = page.locator('.link-popover').first();
    await expect(linkPopover).toBeVisible({ timeout: 5_000 });
    const popoverBox = await linkPopover.boundingBox();
    expect(popoverBox).not.toBeNull();
    const popover = popoverBox!;

    // bottom-start: the popover sits just below the trigger (offset 8 ± flip/shift slack).
    expect(popover.y).toBeGreaterThanOrEqual(trigger.y + trigger.height + 4);
    expect(popover.y).toBeLessThanOrEqual(trigger.y + trigger.height + 32);

    // On a desktop viewport the popover fits, so its left edge aligns near the trigger.
    expect(Math.abs(popover.x - trigger.x)).toBeLessThanOrEqual(16);

    // shift({ padding: 8 }) keeps every edge at least 8px inside the viewport.
    const viewport = page.viewportSize()!;
    expect(popover.x).toBeGreaterThanOrEqual(8);
    expect(popover.y).toBeGreaterThanOrEqual(8);
    expect(popover.x + popover.width).toBeLessThanOrEqual(viewport.width - 8);
    expect(popover.y + popover.height).toBeLessThanOrEqual(viewport.height - 8);

    // The Desktop Chrome project renders under a fine pointer, so the close button
    // is the 28px fine-pointer size. Pin the pointer type first: if this project ever
    // renders coarse, the floor below would silently stop describing what is measured.
    expect(await primaryPointerIsCoarse(page)).toBe(false);
    const closeButton = linkPopover.locator('.link-popover-close').first();
    await expect(closeButton).toBeVisible();
    const closeBox = await closeButton.boundingBox();
    expect(closeBox).not.toBeNull();
    expect(closeBox!.width).toBeGreaterThanOrEqual(CLOSE_BUTTON_FINE_POINTER_MIN - 0.5);
    expect(closeBox!.height).toBeGreaterThanOrEqual(CLOSE_BUTTON_FINE_POINTER_MIN - 0.5);
  });

  test('the close button meets the 44px touch target under a coarse pointer', async ({
    browser,
  }) => {
    const { page, dispose } = await openTouchPage(browser, MARKDOWN_EDITOR_ROUTE, 'light');
    try {
      const linkButton = await revealLinkTrigger(page);
      await linkButton.click();

      const linkPopover = page.locator('.link-popover').first();
      await expect(linkPopover).toBeVisible({ timeout: 5_000 });

      // Pin the pointer type: the 44px floor only describes a coarse pointer.
      expect(await primaryPointerIsCoarse(page)).toBe(true);
      const closeButton = linkPopover.locator('.link-popover-close').first();
      await expect(closeButton).toBeVisible();
      const closeBox = await closeButton.boundingBox();
      expect(closeBox).not.toBeNull();
      expect(closeBox!.width).toBeGreaterThanOrEqual(CLOSE_BUTTON_COARSE_POINTER_MIN - 0.5);
      expect(closeBox!.height).toBeGreaterThanOrEqual(CLOSE_BUTTON_COARSE_POINTER_MIN - 0.5);
    } finally {
      await dispose();
    }
  });
});
