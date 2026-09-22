/// <reference lib="dom" />
/**
 * Regression coverage for COR-327: Slider's `headerVisible` and
 * `displayValue` props.
 *
 * `headerVisible={false}` hides only the label span in the header row —
 * the value span always keeps rendering, with no layout gap left behind,
 * and a thumb's accessible name is unaffected (it always comes from
 * `label`). `displayValue` replaces only that value span's visible text;
 * the `valueText` ARIA formatter (and therefore `aria-valuetext`) is a
 * separate, untouched formatter. Inside `<FormField>`, Slider's existing
 * automatic label suppression (via context) composes with `headerVisible`
 * rather than being replaced by it.
 */

import { loadManifest, THEMES, VIEWPORTS } from '@lostgradient/testing';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './component-page-fixture.ts';
import { fixtureRoute } from './layout-fixture.ts';

const SLIDER_ROUTE = fixtureRoute('slider');
const manifest = loadManifest();
const sliderEntry = manifest.find((candidate) => candidate.slug === 'slider');
if (sliderEntry === undefined) throw new Error('Missing manifest entry for slider.');

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

test.describe('Slider header and value', () => {
  for (const theme of THEMES) {
    for (const viewport of VIEWPORTS) {
      test(`responsive light and dark: ${theme} at ${viewport.name}`, async ({ componentPage }) => {
        const page = await componentPage.open({
          entry: sliderEntry,
          theme,
          viewport,
          fixtureName: 'assertion',
        });

        // Compact single: label hidden, value keeps rendering with no
        // layout gap (the header renders exactly one child).
        const compactSingle = page.locator('#example-mount-compact-single .cinder-slider');
        await expect(compactSingle.locator('.cinder-slider__label')).toHaveCount(0);
        await expect(compactSingle.locator('.cinder-slider__value')).toHaveText('7 notes · C4–B4');
        const headerChildCount = await compactSingle
          .locator('.cinder-slider__header')
          .evaluate((element) => element.children.length);
        expect(headerChildCount).toBe(1);

        // Compact range: displayValue formats the full [low, high] tuple.
        const compactRange = page.locator('#example-mount-compact-range .cinder-slider');
        await expect(compactRange.locator('.cinder-slider__label')).toHaveCount(0);
        await expect(compactRange.locator('.cinder-slider__value')).toHaveText('3–19');

        // FormField composition: the label stays hidden (FormField owns it
        // via context) and the formatted value still renders.
        const formFieldSlider = page.locator('#example-mount-compact-formfield .cinder-slider');
        await expect(formFieldSlider.locator('.cinder-slider__label')).toHaveCount(0);
        await expect(formFieldSlider.locator('.cinder-slider__value')).toHaveText(
          '7 notes · C4–B4',
        );
        await expect(
          page.locator('#example-mount-compact-formfield .cinder-form-field__label'),
        ).toHaveText('Scale length');
      });
    }
  }

  test('keyboard and disabled states', async ({ page }) => {
    await page.goto(SLIDER_ROUTE, { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    // Keyboard: ArrowRight advances the value, and displayValue's output
    // updates to match — headerVisible={false} doesn't disturb keyboard
    // interaction or the reactive value text.
    const compactThumb = page.locator('#example-mount-compact-single [role="slider"]');
    await blurToBody(page);
    await tabUntilFocused(page, compactThumb, 'compact single thumb');
    await expect(compactThumb).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(compactThumb).toHaveAttribute('aria-valuenow', '8');
    await expect(page.locator('#example-mount-compact-single .cinder-slider__value')).toHaveText(
      '8 notes · C4–B4',
    );

    // Disabled: the value stays visible and formatted even though the
    // control can't be interacted with, and the thumb is removed from tab
    // order like every other disabled Slider.
    const disabledSlider = page.locator('#example-mount-compact-disabled .cinder-slider');
    const disabledThumb = disabledSlider.locator('[role="slider"]');
    await expect(disabledSlider.locator('.cinder-slider__label')).toHaveCount(0);
    await expect(disabledSlider.locator('.cinder-slider__value')).toHaveText('7 notes · C4–B4');
    await expect(disabledThumb).toHaveAttribute('tabindex', '-1');
    await expect(disabledThumb).toHaveAttribute('aria-disabled', 'true');
  });

  test('controlled updates and hydration', async ({ page }) => {
    await page.goto(SLIDER_ROUTE, { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');

    // Hydration: the server-rendered formatted text survives hydration
    // unchanged — no flash of unformatted content, no mismatch warning
    // (component-page-fixture-style diagnostics aren't wired on a plain
    // page.goto, so this also re-reads the value after settling to prove
    // the DOM node wasn't left in a stale pre-hydration state).
    const singleValue = page.locator('#example-mount-compact-single .cinder-slider__value');
    const rangeValue = page.locator('#example-mount-compact-range .cinder-slider__value');
    await expect(singleValue).toHaveText('7 notes · C4–B4');
    await expect(rangeValue).toHaveText('3–19');

    // Controlled updates: an external button — not the slider's own
    // pointer/keyboard handling — mutates the bound `value`, and
    // `displayValue`'s output reacts to that externally-driven change the
    // same way it reacts to an internal one.
    await page.locator('#compact-single-increment').click();
    await expect(singleValue).toHaveText('8 notes · C4–B4');
    await expect(page.locator('#example-mount-compact-single [role="slider"]')).toHaveAttribute(
      'aria-valuenow',
      '8',
    );

    await page.locator('#compact-range-increment').click();
    await expect(rangeValue).toHaveText('3–20');
    const [, high] = await page.locator('#example-mount-compact-range [role="slider"]').all();
    await expect(high!).toHaveAttribute('aria-valuenow', '20');

    // The FormField-wrapped Slider shares the same controlled `value` as
    // the standalone compact single Slider in this fixture, so the
    // increment above should be reflected there too.
    await expect(page.locator('#example-mount-compact-formfield .cinder-slider__value')).toHaveText(
      '8 notes · C4–B4',
    );
  });
});
