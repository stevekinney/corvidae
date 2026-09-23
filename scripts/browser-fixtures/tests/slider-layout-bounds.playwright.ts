/// <reference lib="dom" />
/**
 * Regression coverage for COR-291: Slider's endpoint thumbs used to
 * overhang past the root's inline layout bounds by half the thumb's
 * diameter at min/max, making the control visibly wider than an
 * equal-width sibling (reproduced with a full-width Select alongside a
 * Slider — see the fretboard/octave-range bug report).
 *
 * The fix insets the fill/tick/thumb travel interval by half the actual
 * rendered thumb size (rem-based, so it follows font scaling) rather than
 * a hardcoded pixel offset, and keeps pointer mapping in sync so clicks in
 * the reserved margin — including at the track's physical edges — still
 * resolve to min/max.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import { fixtureRoute } from './layout-fixture.ts';

const SLIDER_ROUTE = fixtureRoute('slider');

// Matches the 0.5 CSS pixel tolerance the issue's geometry test contract
// specifies for every fixture, including the 200%-font-size one.
const PIXEL_TOLERANCE = 0.5;

type Box = { x: number; y: number; width: number; height: number };

async function requiredBox(locator: Locator, name: string): Promise<Box> {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  expect(box, `${name} has a browser layout box`).not.toBeNull();
  if (box === null) throw new Error(`${name} has no layout box`);
  return box;
}

async function blurToBody(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    document.body.focus();
  });
}

async function tabUntilFocused(page: Page, target: Locator, label: string, maxPresses = 100) {
  for (let attempt = 0; attempt < maxPresses; attempt += 1) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error(`Tab walk did not reach ${label}.`);
}

test.describe('Slider layout bounds', () => {
  test('endpoint thumbs stay inside root', async ({ page }) => {
    await page.goto(SLIDER_ROUTE, { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    const cases: Array<{ section: string; thumbs: readonly string[] }> = [
      { section: '#example-mount-endpoint-min', thumbs: ['single'] },
      { section: '#example-mount-endpoint-max', thumbs: ['single'] },
      { section: '#example-mount-range-endpoints', thumbs: ['low', 'high'] },
    ];

    for (const { section, thumbs } of cases) {
      const root = page.locator(`${section} .cinder-slider`);
      const adjacent = page.locator(`${section} .cinder-select-field`);
      const header = page.locator(`${section} .cinder-slider__header`);

      const rootBox = await requiredBox(root, `${section} root`);
      const adjacentBox = await requiredBox(adjacent, `${section} adjacent control`);
      const headerBox = await requiredBox(header, `${section} header`);

      // The Slider root's outer edges line up with an equal-width sibling.
      expect(
        Math.abs(rootBox.x - adjacentBox.x),
        `${section}: root left edge matches adjacent control`,
      ).toBeLessThanOrEqual(PIXEL_TOLERANCE);
      expect(
        Math.abs(rootBox.x + rootBox.width - (adjacentBox.x + adjacentBox.width)),
        `${section}: root right edge matches adjacent control`,
      ).toBeLessThanOrEqual(PIXEL_TOLERANCE);

      // The header keeps the full root width — only the track/thumb travel
      // interval is inset, not the label/value row.
      expect(
        Math.abs(headerBox.width - rootBox.width),
        `${section}: header spans the full root width`,
      ).toBeLessThanOrEqual(PIXEL_TOLERANCE);

      for (const thumbName of thumbs) {
        const thumb = page.locator(`${section} [data-cinder-slider-thumb="${thumbName}"]`);
        const thumbBox = await requiredBox(thumb, `${section} ${thumbName} thumb`);

        expect(
          thumbBox.x,
          `${section}: ${thumbName} thumb left edge stays inside root`,
        ).toBeGreaterThanOrEqual(rootBox.x - PIXEL_TOLERANCE);
        expect(
          thumbBox.x + thumbBox.width,
          `${section}: ${thumbName} thumb right edge stays inside root`,
        ).toBeLessThanOrEqual(rootBox.x + rootBox.width + PIXEL_TOLERANCE);
      }
    }
  });

  test('pointer endpoints match min max in both directions', async ({ page }) => {
    await page.goto(SLIDER_ROUTE, { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    const thumb = page.locator('#example-mount-basic [role="slider"]');
    const track = page.locator('#example-mount-basic .cinder-slider__track');

    async function clickPhysicalEdges(): Promise<void> {
      const trackBox = await requiredBox(track, 'basic track');
      const midY = trackBox.y + trackBox.height / 2;
      await page.mouse.click(trackBox.x + 1, midY);
      await expect(thumb, 'clicking the physical left edge').toHaveAttribute('aria-valuenow', '0');
      await page.mouse.click(trackBox.x + trackBox.width - 1, midY);
      await expect(thumb, 'clicking the physical right edge').toHaveAttribute(
        'aria-valuenow',
        '100',
      );
    }

    // LTR: left → min, right → max, even though both physical edges fall
    // inside the reserved half-thumb margin, not on the inset travel bound.
    await clickPhysicalEdges();

    // RTL: the mapping flips — left → max, right → min. Each direction gets
    // its own fresh navigation: the thumb that a "left → max" click leaves
    // behind renders flush with the *physical right* edge (the rendered
    // side of a thumb doesn't mirror with direction, only the pointer
    // mapping does — unrelated, pre-existing Slider behavior), which would
    // otherwise sit exactly where the very next "physical right edge" click
    // needs to land on the track, not on that thumb.
    async function assertRtlEdge(edge: 'left' | 'right', expected: string): Promise<void> {
      await page.goto(SLIDER_ROUTE, { waitUntil: 'load' });
      await page.waitForLoadState('networkidle');
      await page.evaluate(() => {
        document.documentElement.dir = 'rtl';
      });
      const trackBox = await requiredBox(track, `basic track (rtl, ${edge})`);
      const midY = trackBox.y + trackBox.height / 2;
      const x = edge === 'left' ? trackBox.x + 1 : trackBox.x + trackBox.width - 1;
      await page.mouse.click(x, midY);
      await expect(thumb, `rtl: clicking the physical ${edge} edge`).toHaveAttribute(
        'aria-valuenow',
        expected,
      );
    }

    await assertRtlEdge('left', '100');
    await assertRtlEdge('right', '0');
  });

  test('font scaling and focus rings remain usable', async ({ page }) => {
    await page.goto(SLIDER_ROUTE, { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    // Rem-based thumb sizing must follow font-size scaling rather than a
    // fixed pixel inset — the geometry test contract's font fixture.
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '200%';
    });

    for (const section of ['#example-mount-endpoint-min', '#example-mount-endpoint-max']) {
      const root = page.locator(`${section} .cinder-slider`);
      const thumb = page.locator(`${section} [role="slider"]`);
      const rootBox = await requiredBox(root, `${section} root at 200% font`);
      const thumbBox = await requiredBox(thumb, `${section} thumb at 200% font`);

      expect(
        thumbBox.x,
        `${section}: thumb left edge stays inside root at 200% font`,
      ).toBeGreaterThanOrEqual(rootBox.x - PIXEL_TOLERANCE);
      expect(
        thumbBox.x + thumbBox.width,
        `${section}: thumb right edge stays inside root at 200% font`,
      ).toBeLessThanOrEqual(rootBox.x + rootBox.width + PIXEL_TOLERANCE);
    }

    // The endpoint thumb's focus ring stays visible under font scaling.
    await blurToBody(page);
    const minThumb = page.locator('#example-mount-endpoint-min [role="slider"]');
    await tabUntilFocused(page, minThumb, 'minimum-endpoint thumb');
    await expect(minThumb).toBeFocused();
    const ring = await minThumb.evaluate((element) => {
      const styles = getComputedStyle(element);
      return {
        boxShadow: styles.boxShadow,
        matchesFocusVisible: element.matches(':focus-visible'),
      };
    });
    expect(ring.matchesFocusVisible).toBe(true);
    expect(ring.boxShadow).not.toBe('none');
  });
});
