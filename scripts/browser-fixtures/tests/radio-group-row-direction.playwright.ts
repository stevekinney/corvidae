/**
 * Browser regression for COR-452: a basic RadioGroup option row must compute
 * to row-direction flex layout — control and label on the same line — rather
 * than inheriting FormFieldFrame's column direction. See
 * `radio-group.test.ts`'s `RadioGroup — row-direction cascade (COR-452)`
 * describe block for the accompanying source-graph (all-styles / slim-styles)
 * regressions; this test verifies the rendered, computed result on the
 * existing `radio-group` fixture rather than the CSS source.
 */

import { loadManifest } from '@lostgradient/testing';
import { expect, test } from '@playwright/test';

const manifest = loadManifest();
function fixtureRoute(slug: string): string {
  const entry = manifest.find((candidate) => candidate.slug === slug);
  const hash = entry?.fixtures?.find((fixture) => fixture.name === 'assertion')?.fixtureContentHash;
  if (hash === undefined) throw new Error(`Assertion fixture hash missing for ${slug}.`);
  return `/page/${slug}?snapshot=1&fixture=assertion&fixtureContentHash=${hash}`;
}
const RADIO_GROUP_ROUTE = fixtureRoute('radio-group');

test.describe('RadioGroup option row direction', () => {
  test('a basic option row computes to row-direction flex layout', async ({ page }) => {
    await page.goto(RADIO_GROUP_ROUTE, { waitUntil: 'load' });
    await page.waitForSelector('#app > *', { state: 'visible', timeout: 20_000 });

    const row = page.locator('.cinder-radio-row').first();
    await expect(row).toBeVisible();

    const geometry = await row.evaluate((element) => {
      const computed = getComputedStyle(element);
      const control = element.querySelector('.cinder-radio-row__control');
      const label = element.querySelector('.cinder-radio-row__label');
      return {
        display: computed.display,
        flexDirection: computed.flexDirection,
        controlTop: control?.getBoundingClientRect().top ?? null,
        labelTop: label?.getBoundingClientRect().top ?? null,
      };
    });

    // `inline-flex` blockifies to `flex` in this layout context (a direct
    // child of the group's own column flex container); that is expected and
    // is not evidence of a missing stylesheet — see COR-452's own note on
    // this. Either resolved value is an inline-level or block-level flex
    // container, so `flex-direction` is the property this test actually cares
    // about; `display` is asserted only to confirm SOME flex formatting
    // context still applies.
    expect(['flex', 'inline-flex']).toContain(geometry.display);
    expect(geometry.flexDirection).toBe('row');
    // The regression this guards: with the column direction bug, the control
    // renders above the label instead of beside it, so their top edges differ
    // by roughly the control's own height. On the same horizontal line their
    // tops are equal (both are centered on the row's cross axis).
    expect(geometry.controlTop).not.toBeNull();
    expect(geometry.labelTop).not.toBeNull();
    // Same line: a few px apart from sub-pixel centering, never the ~18px+
    // vertical offset a column-stacked control/label pair would produce.
    expect(Math.abs(geometry.controlTop! - geometry.labelTop!)).toBeLessThan(10);
  });

  test('every basic option row in the group shares the same row layout', async ({ page }) => {
    await page.goto(RADIO_GROUP_ROUTE, { waitUntil: 'load' });
    await page.waitForSelector('#app > *', { state: 'visible', timeout: 20_000 });

    const rows = page.locator('.cinder-radio-row');
    const count = await rows.count();
    expect(count).toBeGreaterThan(1);

    const directions = await rows.evaluateAll((elements) =>
      elements.map((element) => getComputedStyle(element).flexDirection),
    );
    expect(directions).toEqual(directions.map(() => 'row'));
  });
});
