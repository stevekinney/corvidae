/// <reference lib="dom" />
/**
 * COR-2449 (AC3): a surface inside a surface is flat by default, and its `framed` opt-in draws the
 * frame. Each pair is drawn by the component's own fixture (DescriptionList `fields`, a Collapsible
 * nested in a Collapsible's open panel, a Table inside a Card), so the screenshot shows the default
 * beside the opt-in, and the measurement here holds that the default draws no frame and the opt-in
 * does. happy-dom resolves no cascade, so it is measured in a browser.
 */

import { fixtureRoute } from '@lostgradient/testing/playwright/overlay-fixture';
import { expect, test } from '@playwright/test';

const FRAME = ['border-top-width', 'border-top-style'] as const;

test.describe('flat by default, framed on request', () => {
  test('DescriptionList fields draws no tinted frame by default, and the framed one does', async ({
    page,
  }) => {
    await page.goto(fixtureRoute('description-list'), { waitUntil: 'load' });
    const flat = page.getByTestId('description-list-fields-flat').locator('dl');
    const framed = page.getByTestId('description-list-fields-framed').locator('dl');
    // A framed group paints its fill on the list's `::before` (COR-2394), so both are read there.
    const fill = async (list: typeof flat) =>
      list.evaluate((element) => ({
        own: getComputedStyle(element).backgroundColor,
        layer: getComputedStyle(element, '::before').backgroundColor,
      }));
    const [flatFill, framedFill] = await Promise.all([fill(flat), fill(framed)]);
    expect(flatFill).toEqual({ own: 'rgba(0, 0, 0, 0)', layer: 'rgba(0, 0, 0, 0)' });
    expect(framedFill.layer).not.toBe('rgba(0, 0, 0, 0)');
    await expect(flat).toHaveCSS('border-top-width', '0px');
  });

  test('a Collapsible in an open Collapsible panel is flat by default, and the framed one keeps its card', async ({
    page,
  }) => {
    await page.goto(fixtureRoute('collapsible'), { waitUntil: 'load' });
    const inner = (testId: string) =>
      page.getByTestId(testId).locator('.cinder-collapsible__panel .cinder-collapsible').first();
    await expect(inner('collapsible-nested-flat')).toBeVisible();
    await expect(inner('collapsible-nested-flat')).toHaveCSS('border-top-width', '0px');
    await expect(inner('collapsible-nested-framed')).toBeVisible();
    await expect(inner('collapsible-nested-framed')).not.toHaveCSS('border-top-width', '0px');
    // The outer disclosure keeps its own frame in both: nesting changes only the inner one.
    await expect(
      page.getByTestId('collapsible-nested-flat').locator('.cinder-collapsible').first(),
    ).not.toHaveCSS('border-top-width', '0px');
  });

  test('a Table in a Card draws no frame of its own by default, and the framed one does', async ({
    page,
  }) => {
    await page.goto(fixtureRoute('table'), { waitUntil: 'load' });
    // The scroll box owns a Table's frame when it has one; a Table without one draws its own.
    const frameOf = (testId: string) =>
      page.getByTestId(testId).locator('.cinder-table-scroll, table.cinder-table').first();
    const flat = frameOf('table-in-card-flat');
    const framed = frameOf('table-in-card-framed');
    for (const property of FRAME) {
      await expect(framed).not.toHaveCSS(property, property.endsWith('width') ? '0px' : 'none');
    }
    await expect(flat).toHaveCSS('border-top-width', '0px');
  });
});

/**
 * COR-2634: a Collapsible's open, disabled, chevron and flat styles apply to that Collapsible alone,
 * never to one nested in its panel. Each nested element is compared with the same element of a
 * top-level reference that has the values the nested one should show, read on the same page. The
 * label's weight is not compared: `cinder-_label-text` sets the same semibold weight the flat label
 * rule does, so the comparison would hold under the leaking rules too.
 */
test.describe('nested Collapsible isolation', () => {
  type Part = 'trigger' | 'chevron' | 'panel-inner';
  type Page = import('@playwright/test').Page;

  const PART_SELECTOR: Record<Part, string> = {
    trigger: ':scope > .cinder-collapsible__trigger',
    chevron: ':scope > .cinder-collapsible__trigger > .cinder-collapsible__chevron',
    'panel-inner': ':scope > .cinder-collapsible__panel > .cinder-collapsible__panel-inner',
  };

  /** The Collapsible nested directly in the panel of the case's outer one. */
  const nested = (page: Page, testId: string, part: Part) =>
    page
      .getByTestId(testId)
      .locator(
        ':scope > .cinder-collapsible > .cinder-collapsible__panel > .cinder-collapsible__panel-inner > .cinder-collapsible',
      )
      .locator(PART_SELECTOR[part]);

  /** A top-level reference Collapsible, which carries its `data-testid` on its root. */
  const reference = (page: Page, testId: string, part: Part) =>
    page.getByTestId(testId).locator(PART_SELECTOR[part]);

  const read = (locator: ReturnType<Page['locator']>, property: string) =>
    locator.evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), property);

  const load = (page: Page) => page.goto(fixtureRoute('collapsible'), { waitUntil: 'load' });

  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await load(page);
  });

  async function expectMatchingStyles(
    page: Page,
    testId: string,
    referenceId: string,
    part: Part,
    properties: readonly string[],
  ) {
    const actual = nested(page, testId, part);
    const expected = reference(page, referenceId, part);
    for (const property of properties) {
      await expect
        .soft(actual, `${testId}: ${part} ${property}`)
        .toHaveCSS(property, await read(expected, property));
    }
  }

  for (const [testId, referenceId, property] of [
    ['collapsible-nested-closed', 'collapsible-reference-flat-closed', 'transform'],
    ['collapsible-nested-disabled-outer', 'collapsible-reference-flat-closed', 'color'],
    ['collapsible-nested-start', 'collapsible-reference-flat-start-closed', 'transform'],
  ] as const) {
    test(`${testId}: chevron ${property}, at rest`, async ({ page }) => {
      await expectMatchingStyles(page, testId, referenceId, 'chevron', [property]);
    });
  }

  test('closed framed trigger keeps both bottom corners', async ({ page }) => {
    await expectMatchingStyles(
      page,
      'collapsible-nested-framed-closed',
      'collapsible-reference-default-closed',
      'trigger',
      ['border-end-start-radius', 'border-end-end-radius'],
    );
  });

  test('framed trigger and panel keep their resting styles inside a flat Collapsible', async ({
    page,
  }) => {
    const testId = 'collapsible-nested-framed-in-flat';
    const referenceId = 'collapsible-reference-default-open';
    await expectMatchingStyles(page, testId, referenceId, 'trigger', [
      'padding-top',
      'background-color',
      'border-start-start-radius',
    ]);
    await expectMatchingStyles(page, testId, referenceId, 'panel-inner', [
      'padding-top',
      'background-color',
      'border-end-start-radius',
    ]);
  });

  test('collapsible-nested-closed: chevron transform, after opening', async ({ page }) => {
    const expected = await read(
      reference(page, 'collapsible-reference-flat-open', 'chevron'),
      'transform',
    );
    await nested(page, 'collapsible-nested-closed', 'trigger').click();
    await expect(nested(page, 'collapsible-nested-closed', 'trigger')).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(nested(page, 'collapsible-nested-closed', 'chevron')).toHaveCSS(
      'transform',
      expected,
    );
  });

  test('framed trigger and chevron keep their hover colors inside a flat Collapsible', async ({
    page,
  }) => {
    const testId = 'collapsible-nested-framed-in-flat';
    const referenceId = 'collapsible-reference-default-open';
    await reference(page, referenceId, 'trigger').hover();
    const background = await read(reference(page, referenceId, 'trigger'), 'background-color');
    const color = await read(reference(page, referenceId, 'chevron'), 'color');
    await nested(page, testId, 'trigger').hover();
    await expect.soft(nested(page, testId, 'trigger')).toHaveCSS('background-color', background);
    await expect.soft(nested(page, testId, 'chevron')).toHaveCSS('color', color);
  });

  test('collapsible-nested-framed-in-flat: trigger background-color, pressed', async ({ page }) => {
    // Releasing the mouse toggles a trigger, so each side is read while held, on a fresh page.
    const referenceTrigger = reference(page, 'collapsible-reference-default-open', 'trigger');
    await referenceTrigger.hover();
    await page.mouse.down();
    const expected = await read(referenceTrigger, 'background-color');
    await page.mouse.up();

    await page.reload({ waitUntil: 'load' });
    const nestedTrigger = nested(page, 'collapsible-nested-framed-in-flat', 'trigger');
    await nestedTrigger.hover();
    await page.mouse.down();
    await expect(nestedTrigger).toHaveCSS('background-color', expected);
    await page.mouse.up();
  });
});
