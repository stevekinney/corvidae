import { expect, test } from '@playwright/test';
import { environmentConfiguration } from '../environment-configuration.ts';
import { fixtureRoute } from './layout-fixture.ts';

const CAROUSEL_ROUTE = fixtureRoute('carousel');
const nativePanTouchAction = /^(?:manipulation|pan-x pan-y pinch-zoom)$/;

test.describe('Carousel interaction and layout', () => {
  test('carousel uses a native snapping track and keeps pagination in sync', async ({ page }) => {
    await page.goto(CAROUSEL_ROUTE, { waitUntil: 'load' });
    const scope = page.locator('#example-mount-basic');
    const viewport = scope.locator('.cinder-carousel__viewport');
    await expect(viewport).toHaveCSS('scroll-snap-type', /x mandatory/);
    await expect(viewport).toHaveCSS('touch-action', nativePanTouchAction);
    await expect(viewport.locator('.cinder-carousel__slide')).toHaveCount(3);
    await viewport.evaluate((element) => {
      if (!(element instanceof HTMLElement)) throw new Error('Missing viewport');
      element.scrollLeft = element.clientWidth;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(scope.locator('.cinder-carousel__dot[aria-current="true"]')).toHaveAttribute(
      'aria-label',
      'Go to Patterns',
    );
    await expect(viewport.locator('.cinder-carousel__slide[aria-hidden="true"]')).toHaveCount(2);
  });
  test('slidesPerView makes multiple slides simultaneously interactive', async ({ page }) => {
    await page.goto(CAROUSEL_ROUTE, { waitUntil: 'load' });
    const scope = page.locator('#example-mount-multi-view');
    const viewport = scope.locator('.cinder-carousel__viewport');
    await expect(viewport).toBeVisible();
    const slides = viewport.locator('.cinder-carousel__slide');
    await expect(slides.nth(0)).not.toHaveAttribute('aria-hidden', 'true');
    await expect(slides.nth(1)).not.toHaveAttribute('aria-hidden', 'true');
    await expect(slides.nth(2)).toHaveAttribute('aria-hidden', 'true');
    await expect(scope.locator('[aria-live]')).toHaveText(/^Slides 1–2 of 6$/);
  });
  test('mouse drag disables native snapping only while dragging, then restores it', async ({
    page,
  }) => {
    await page.goto(CAROUSEL_ROUTE, { waitUntil: 'load' });
    const viewport = page.locator('#example-mount-basic .cinder-carousel__viewport');
    const box = await viewport.boundingBox();
    if (!box) throw new Error('Carousel viewport has no layout box.');
    const startX = box.x + box.width * 0.75;
    const y = box.y + box.height / 2;
    await page.mouse.move(startX, y);
    await page.mouse.down();
    await expect(viewport).toHaveCSS('scroll-snap-type', 'none');
    await page.mouse.move(startX - 80, y, { steps: 5 });
    await expect(viewport).toHaveAttribute('data-cinder-dragging', '');
    await page.mouse.up();
    await expect(viewport).not.toHaveAttribute('data-cinder-dragging', '');
    await expect(viewport).toHaveCSS('scroll-snap-type', /x mandatory/);
  });
  test('the carousel remains normally interactive after a mouse drag releases', async ({
    page,
  }) => {
    await page.goto(CAROUSEL_ROUTE, { waitUntil: 'load' });
    const scope = page.locator('#example-mount-basic');
    const viewport = scope.locator('.cinder-carousel__viewport');
    const box = await viewport.boundingBox();
    if (!box) throw new Error('Carousel viewport has no layout box.');
    const startX = box.x + box.width * 0.75;
    const y = box.y + box.height / 2;
    await page.mouse.move(startX, y);
    await page.mouse.down();
    await page.mouse.move(startX - 80, y, { steps: 5 });
    await page.mouse.up();
    await scope.locator('.cinder-carousel__dot').nth(2).click();
    await expect(scope.locator('.cinder-carousel__dot').nth(2)).toHaveAttribute(
      'aria-current',
      'true',
    );
  });
  test('carousel track remains scrollable in a touch-capable context', async ({ browser }) => {
    const baseURL = environmentConfiguration().browserFixtureUrl;
    if (baseURL === undefined) throw new Error('BROWSER_FIXTURE_URL is required.');
    const context = await browser.newContext({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
      baseURL,
    });
    try {
      const page = await context.newPage();
      await page.goto(CAROUSEL_ROUTE, { waitUntil: 'load' });
      const viewport = page.locator('#example-mount-basic .cinder-carousel__viewport');
      await expect(viewport).toBeVisible();
      await expect(viewport).toHaveCSS('touch-action', nativePanTouchAction);
      await expect(viewport).toHaveCSS('scroll-snap-type', /x mandatory/);
    } finally {
      await context.close();
    }
  });

  // COR-181: focus pause/rotation-order/descendant-keyboard-ownership cases
  // that need a real browser — actual Tab order, real focus recovery, and
  // genuine text-caret/range-input arrow-key behavior, none of which
  // happy-dom's unit tests can authoritatively prove.
  test('keyboard tab order reaches the rotation control before the viewport slides', async ({
    page,
  }) => {
    await page.goto(CAROUSEL_ROUTE, { waitUntil: 'load' });
    await page.locator('#before-keyboard-carousel').focus();
    await page.keyboard.press('Tab');
    await expect(
      page.locator('#example-mount-keyboard .cinder-carousel__control--pause'),
    ).toBeFocused();
  });

  test('keyboard navigation moves outgoing-slide focus to the carousel root before it goes inert', async ({
    page,
  }) => {
    await page.goto(CAROUSEL_ROUTE, { waitUntil: 'load' });
    const scope = page.locator('#example-mount-keyboard');
    const link = scope.locator('.cinder-carousel__slide').first().getByRole('link');
    await link.focus();

    await page.keyboard.press('ArrowRight');

    await expect(scope.locator('.cinder-carousel')).toBeFocused();
  });

  test('editable notes and range slide controls keep their own arrow-key behavior instead of navigating slides', async ({
    page,
  }) => {
    await page.goto(CAROUSEL_ROUTE, { waitUntil: 'load' });
    const scope = page.locator('#example-mount-keyboard');
    const dots = scope.locator('.cinder-carousel__dot');

    const notes = scope.getByLabel('Introduction notes');
    await notes.click();
    await notes.press('End');
    const caretBeforeArrow = await notes.evaluate(
      (element) => (element as HTMLInputElement).selectionStart,
    );
    await notes.press('ArrowLeft');
    const caretAfterArrow = await notes.evaluate(
      (element) => (element as HTMLInputElement).selectionStart,
    );
    // The caret actually moved (native input behavior owns the key) and the
    // carousel did not treat it as a "previous slide" shortcut.
    expect(caretAfterArrow).toBe((caretBeforeArrow ?? 0) - 1);
    await expect(dots.nth(0)).toHaveAttribute('aria-current', 'true');

    const volume = scope.getByLabel('Introduction volume');
    await volume.click();
    const volumeBefore = Number(await volume.inputValue());
    await volume.press('ArrowRight');
    const volumeAfter = Number(await volume.inputValue());
    // The range's own value actually changed (native widget owns the key)
    // and the carousel did not treat it as a "next slide" shortcut either.
    expect(volumeAfter).toBeGreaterThan(volumeBefore);
    await expect(dots.nth(0)).toHaveAttribute('aria-current', 'true');
  });

  test('clicking Play explicitly restarts rotation and keeps focus on the control', async ({
    page,
  }) => {
    await page.goto(CAROUSEL_ROUTE, { waitUntil: 'load' });
    const scope = page.locator('#example-mount-keyboard');
    const rotationControl = scope.locator('.cinder-carousel__control--pause');
    const dots = scope.locator('.cinder-carousel__dot');

    await rotationControl.click();
    await expect(rotationControl).toHaveText('Play');
    // A full interval elapses while paused; a genuinely stopped rotation must
    // not advance on its own.
    await page.waitForTimeout(1_200);
    await expect(dots.nth(0)).toHaveAttribute('aria-current', 'true');

    await rotationControl.click();
    await expect(rotationControl).toHaveText('Pause');
    await expect(rotationControl).toBeFocused();

    // Hover pausing is independent of the explicit Play/Pause toggle — the
    // pointer is still resting on the control from the click above, and
    // `isHovered` alone would keep rotation stopped regardless of
    // `userPaused`. Move away to isolate what this test is actually proving:
    // the EXPLICIT restart, not merely the absence of hover.
    await page.mouse.move(0, 0);

    await expect(dots.nth(1)).toHaveAttribute('aria-current', 'true', { timeout: 5_000 });
  });
});
