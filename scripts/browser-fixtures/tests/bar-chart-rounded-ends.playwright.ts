/// <reference lib="dom" />
/**
 * A BarChart rounds a bar only at its end away from the baseline, and a stack only at its
 * outermost visible segment on each side of zero, so every join is square. Read in a browser,
 * where the clip each end draws resolves, on the `stacked` fixture: a vertical and a horizontal
 * stack with a zero top segment and values below zero, and the same data grouped.
 */

import { expect, test, type Page } from '@playwright/test';
import { fixtureRoute } from './overlay-fixture.ts';

const R = '3px';
const CLIP = {
  top: `inset(0px round ${R} ${R} 0px 0px)`,
  right: `inset(0px round 0px ${R} ${R} 0px)`,
  bottom: `inset(0px round 0px 0px ${R} ${R})`,
  left: `inset(0px round ${R} 0px 0px ${R})`,
  square: 'none',
} as const;

/** Each bar's computed clip, keyed `series@category`, in one chart. */
async function clips(page: Page, testId: string): Promise<Record<string, string>> {
  return page
    .locator(`[data-testid="${testId}"]`)
    .evaluate((root) =>
      Object.fromEntries(
        [...root.querySelectorAll('rect.cinder-bar-chart__bar')].map((bar) => [
          `${bar.getAttribute('data-cinder-series')}@${bar.getAttribute('data-cinder-category')}`,
          getComputedStyle(bar).clipPath,
        ]),
      ),
    );
}

test.describe('BarChart rounded ends', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(fixtureRoute('bar-chart', { fixtureName: 'stacked' }), { waitUntil: 'load' });
    await page
      .locator('[data-testid="vertical-grouped"] rect.cinder-bar-chart__bar')
      .first()
      .waitFor();
  });

  test('a vertical stack rounds only the top of its topmost visible segment', async ({ page }) => {
    expect(await clips(page, 'vertical-stacked')).toEqual({
      'open@Week 1': CLIP.square,
      'pending@Week 1': CLIP.square,
      'closed@Week 1': CLIP.square,
      'reopened@Week 1': CLIP.top,
      // A zero top segment passes the rounded end down to the next visible one.
      'open@Week 2': CLIP.square,
      'pending@Week 2': CLIP.square,
      'closed@Week 2': CLIP.top,
      'reopened@Week 2': CLIP.square,
      // Below zero the stack grows down and rounds only its lowest segment's bottom.
      'open@Week 3': CLIP.square,
      'pending@Week 3': CLIP.square,
      'closed@Week 3': CLIP.top,
      'reopened@Week 3': CLIP.bottom,
    });
  });

  test('a horizontal stack rounds its far end: right above zero, left below', async ({ page }) => {
    const result = await clips(page, 'horizontal-stacked');
    expect(result['reopened@Week 1']).toBe(CLIP.right);
    expect(result['closed@Week 2']).toBe(CLIP.right);
    expect(result['reopened@Week 3']).toBe(CLIP.left);
    for (const join of ['open@Week 1', 'pending@Week 1', 'closed@Week 1', 'pending@Week 3']) {
      expect(result[join], join).toBe(CLIP.square);
    }
  });

  test('grouped bars each round their own outer end, square at the baseline', async ({ page }) => {
    const result = await clips(page, 'vertical-grouped');
    expect(result['open@Week 1']).toBe(CLIP.top);
    expect(result['pending@Week 3']).toBe(CLIP.bottom);
    expect(result['reopened@Week 2']).toBe(CLIP.square);
  });
});
