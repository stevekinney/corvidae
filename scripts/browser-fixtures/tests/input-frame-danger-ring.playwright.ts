/// <reference lib="dom" />
/**
 * Regression guard for the focused invalid-state error affordance on the shared
 * `.cinder-_input-frame` partial (issue #409).
 *
 * PR #408 briefly set `border-color: transparent` on
 * `[aria-invalid='true']:focus-visible` WITHOUT a replacement danger ring, so a
 * focused invalid Select lost its red error boundary entirely. No unit test
 * could catch this: happy-dom does not compute `box-shadow`/`border-color`, and
 * `select.test.ts` only asserts the `aria-invalid` attribute. The guarded rule
 * lives in `components/cinder/src/styles/components/_input-frame.css`.
 *
 * Select is the critical consumer: its danger ring comes ONLY from that shared
 * rule (`select.css` has no focused danger ring of its own), so it is the case
 * that regresses if the shared rule is removed again.
 */

import { boxShadowLayerCount, resolvedTokenColor, tabUntilFocused } from '@lostgradient/testing';
import { expect, test } from '@playwright/test';
import { fixtureRoute } from './overlay-fixture.ts';
import { outerBands, parseBoxShadow } from './quiet-focus-rings-support.ts';

test.describe('input-frame danger ring — focused invalid-state error affordance (#409)', () => {
  test('a focused invalid select keeps a danger-colored ring', async ({ page }) => {
    await page.goto(fixtureRoute('select'), { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    // The `with-error` example mounts a Select with `error="…"`, so its native
    // `<select>` carries `aria-invalid="true"` and `.cinder-_input-frame` from
    // the moment it renders — no interaction needed to reach the invalid state.
    const select = page.locator(
      '#example-mount-with-error select.cinder-_input-frame[aria-invalid="true"]',
    );
    await expect(select).toBeVisible();

    const landed = await tabUntilFocused(page, select);
    expect(landed, 'Tab walk should reach the invalid select').toBe(true);
    await expect(select).toBeFocused();

    const dangerColor = await resolvedTokenColor(select, '--cinder-status-danger-solid');
    const result = await select.evaluate((element) => {
      if (!(element instanceof HTMLElement)) throw new Error('Expected an HTMLElement select.');
      const styles = getComputedStyle(element);
      // Paint the border color onto a 1×1 canvas and read its alpha channel so
      // the transparent-border check does not depend on the engine serializing
      // `transparent` to a specific string.
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext('2d');
      let borderAlpha = -1;
      if (context) {
        context.fillStyle = styles.borderTopColor;
        context.fillRect(0, 0, 1, 1);
        borderAlpha = context.getImageData(0, 0, 1, 1).data[3] ?? -1;
      }
      return {
        matchesFocusVisible: element.matches(':focus-visible'),
        boxShadow: styles.boxShadow,
        borderAlpha,
      };
    });

    // The keyboard drove :focus-visible (a programmatic focus would not).
    expect(result.matchesFocusVisible).toBe(true);
    // The danger ring lives in box-shadow, and it is the danger color — not the
    // neutral focus-ring color the broken #408 state fell back to.
    expect(result.boxShadow).not.toBe('none');
    expect(result.boxShadow).toContain(dangerColor);
    expect(result.boxShadow).not.toContain('inset');
    // The recipe keeps two stops (offset stop + danger ring).
    expect(boxShadowLayerCount(result.boxShadow)).toBeGreaterThanOrEqual(2);
    // Updated for COR-1498: the offset stop is 0px and paints nothing, so the
    // only painted band is the 2px danger ring.
    const bands = outerBands(parseBoxShadow(result.boxShadow));
    expect(bands.map((band) => ({ spread: band.spread, color: band.color }))).toEqual([
      { spread: 2, color: dangerColor },
    ]);
    // The danger border is swapped for the ring while focused, so the border is
    // transparent — the regression left it transparent with NO ring to replace it.
    expect(result.borderAlpha).toBe(0);
  });
});
