import { expect, test } from '@playwright/test';
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
    const baseURL = process.env['BROWSER_FIXTURE_URL'];
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
});
