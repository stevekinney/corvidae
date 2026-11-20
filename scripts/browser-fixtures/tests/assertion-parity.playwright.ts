import { loadManifest, VIEWPORTS } from '@lostgradient/testing';

import { expect, test } from '@lostgradient/testing/playwright/component-page-fixture';
import { fixtureRoute } from '@lostgradient/testing/playwright/overlay-fixture';

const entries = loadManifest();

function assertionHash(entry: (typeof entries)[number]): string {
  const hash = entry.fixtures?.find((fixture) => fixture.name === 'assertion')?.fixtureContentHash;
  if (hash === undefined) throw new Error(`Assertion fixture hash missing for ${entry.slug}.`);
  return hash;
}

const tableHeaderFixture = `${fixtureRoute('table')}&header-tokens=1`;

test('the Table wrapper scrolls both ways while keeping the semantic header pinned', async ({
  page,
}) => {
  await page.goto(tableHeaderFixture, { waitUntil: 'load' });
  const wrapper = page.getByRole('region', { name: 'Contributors (comfortable)' });
  const table = wrapper.getByRole('table');
  const header = table.locator('thead');
  const firstRow = table.getByRole('row', { name: /Ada Lovelace/ });
  await expect(table).toHaveJSProperty('tagName', 'TABLE');
  await expect(header).toHaveCSS('position', 'sticky');

  const dimensions = await wrapper.evaluate((element) => {
    // Constrain the viewport enough to overflow independently of the theme's row heights.
    element.style.maxBlockSize = `${element.clientHeight / 2}px`;
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    };
  });
  expect(dimensions.scrollWidth).toBeGreaterThan(dimensions.clientWidth);
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);

  const wrapperBox = (await wrapper.boundingBox())!;
  const before = (await header.boundingBox())!;
  const rowBefore = (await firstRow.boundingBox())!;
  await wrapper.evaluate((element) => element.scrollTo(element.scrollWidth, element.scrollHeight));
  await expect.poll(async () => (await firstRow.boundingBox())!.y).toBeLessThan(rowBefore.y);

  const after = (await header.boundingBox())!;
  expect(Math.abs(after.y - before.y)).toBeLessThan(2);
  // The accessible caption does not add a visible row above the sticky header.
  expect(Math.abs(after.y - wrapperBox.y)).toBeLessThan(2);
});

for (const [density, blockToken, inlineToken, bodyBlockToken, bodyInlineToken] of [
  ['comfortable', 'space-3', 'space-5', 'space-2', 'space-3'],
  ['condensed', 'space-2', 'space-5', 'space-1', 'space-3'],
  ['spacious', 'space-4', 'space-6', 'space-3', 'space-4'],
] as const) {
  test(`the ${density} Table header follows scoped aliases independently of the body`, async ({
    page,
  }) => {
    await page.goto(tableHeaderFixture, { waitUntil: 'load' });
    const wrapper = page.getByRole('region', { name: `Contributors (${density})` });
    const header = wrapper.locator('thead');
    const cell = header.getByRole('columnheader', { name: 'Name' });
    const body = wrapper.getByRole('cell', { name: 'Ada Lovelace' });
    const sort = cell.getByRole('button', { name: 'Name' });
    const indicator = sort.locator('.cinder-table__sort-indicator');
    const defaults = await cell.evaluate((element) => {
      const { backgroundColor, fontSize, paddingInlineStart } = getComputedStyle(element);
      return { backgroundColor, fontSize, paddingInlineStart };
    });

    const expected = await wrapper.evaluate(
      (element, { blockToken, inlineToken, bodyBlockToken, bodyInlineToken }) => {
        const overrides = {
          background: 'surface-inset',
          foreground: 'text-default',
          'sorted-foreground': 'accent-text',
          'font-size': 'text-lg',
          'padding-block': 'space-3',
          'padding-inline': 'space-5',
          'padding-block-condensed': 'space-2',
          'padding-block-spacious': 'space-4',
          'padding-inline-spacious': 'space-6',
        };
        for (const [token, alias] of Object.entries(overrides)) {
          element.style.setProperty(`--cinder-table-header-${token}`, `var(--cinder-${alias})`);
        }

        const probe = document.createElement('span');
        element.append(probe);
        const resolve = (property: string, token: string) => {
          probe.style.setProperty(property, `var(--cinder-${token})`);
          return getComputedStyle(probe).getPropertyValue(property);
        };
        const values = {
          backdrop: resolve('background-color', 'surface'),
          defaultFontSize: resolve('font-size', 'text-xs'),
          background: resolve('background-color', overrides.background),
          foreground: resolve('color', overrides.foreground),
          sorted: resolve('color', overrides['sorted-foreground']),
          fontSize: resolve('font-size', overrides['font-size']),
          block: resolve('padding-block-start', blockToken),
          inline: resolve('padding-inline-start', inlineToken),
          bodyFontSize: resolve('font-size', 'text-sm'),
          bodyBlock: resolve('padding-block-start', bodyBlockToken),
          bodyInline: resolve('padding-inline-start', bodyInlineToken),
        };
        probe.remove();
        return values;
      },
      { blockToken, inlineToken, bodyBlockToken, bodyInlineToken },
    );

    expect(defaults.backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(defaults.fontSize).toBe(expected.defaultFontSize);
    expect(defaults.paddingInlineStart).toBe(expected.bodyInline);
    await expect(cell).toHaveCSS('background-color', expected.background);
    await expect(cell).toHaveCSS('color', expected.foreground);
    await expect(cell).toHaveCSS('font-size', expected.fontSize);
    await expect(sort).toHaveCSS('font-size', expected.fontSize);
    await expect(cell).toHaveCSS('padding-block-start', expected.block);
    await expect(cell).toHaveCSS('padding-inline-start', expected.inline);
    await expect(indicator).toHaveCSS('color', expected.foreground);
    await expect(body).toHaveCSS('font-size', expected.bodyFontSize);
    await expect(body).toHaveCSS('padding-block-start', expected.bodyBlock);
    await expect(body).toHaveCSS('padding-inline-start', expected.bodyInline);
    await expect(header).toHaveCSS('background-color', expected.backdrop);

    await sort.hover();
    const hover = await sort.evaluate((element) => getComputedStyle(element).backgroundColor);
    await wrapper.evaluate((element) => {
      element.style.setProperty('--cinder-table-header-background', 'var(--cinder-surface-raised)');
    });
    await expect(sort).not.toHaveCSS('background-color', hover);

    await sort.click();
    await expect(cell).toHaveAttribute('aria-sort', 'ascending');
    await expect(cell).toHaveCSS('color', expected.sorted);
    await expect(indicator).toHaveCSS('color', expected.sorted);
  });
}

test.describe('number input resting geometry', () => {
  test('desktop steppers fill the grouped control without dead spacing', async ({
    componentPage,
  }) => {
    const entry = entries.find((candidate) => candidate.slug === 'number-input');
    if (entry === undefined) throw new Error('NumberInput is missing from the component manifest.');
    const desktop = VIEWPORTS.find((viewport) => viewport.name === 'desktop');
    if (desktop === undefined) throw new Error('Desktop viewport fixture is missing.');
    const page = await componentPage.open({
      entry,
      theme: 'light',
      viewport: desktop,
      fixtureName: 'assertion',
      fixtureContentHash: assertionHash(entry),
    });
    const group = page.locator('.cinder-input-group.cinder-number-input').first();
    const input = group.locator('.cinder-number-input__input');
    const increment = group.locator('.cinder-number-input__stepper--increment');
    const decrement = group.locator('.cinder-number-input__stepper--decrement');
    await expect(increment).toHaveCount(1);
    await expect(decrement).toHaveCount(1);
    const groupBox = await group.boundingBox();
    const inputBox = await input.boundingBox();
    const incrementBox = await increment.boundingBox();
    const decrementBox = await decrement.boundingBox();
    expect(groupBox).not.toBeNull();
    expect(inputBox).not.toBeNull();
    expect(incrementBox).not.toBeNull();
    expect(decrementBox).not.toBeNull();
    expect(Math.abs(incrementBox!.height - groupBox!.height)).toBeLessThanOrEqual(2);
    expect(Math.abs(decrementBox!.height - groupBox!.height)).toBeLessThanOrEqual(2);
    // The steppers read minus then plus (COR-2449): the field, then decrement, then increment.
    expect(Math.abs(inputBox!.x + inputBox!.width - decrementBox!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(decrementBox!.x + decrementBox!.width - incrementBox!.x)).toBeLessThanOrEqual(
      1,
    );
    expect(
      Math.abs(incrementBox!.x + incrementBox!.width - (groupBox!.x + groupBox!.width)),
    ).toBeLessThanOrEqual(1);
  });
});

test.describe('date picker surface ownership', () => {
  test('uses one custom calendar surface without native date controls', async ({
    componentPage,
  }) => {
    const entry = entries.find((candidate) => candidate.slug === 'date-picker');
    const rangeEntry = entries.find((candidate) => candidate.slug === 'date-range-field');
    if (entry === undefined || rangeEntry === undefined)
      throw new Error('Date fixtures are missing.');
    const viewport = { name: 'desktop' as const, width: 1440, height: 1080 };
    const page = await componentPage.open({
      entry,
      theme: 'light',
      viewport,
      fixtureName: 'assertion',
      fixtureContentHash: assertionHash(entry),
    });
    const datePicker = page.locator('.cinder-date-picker');
    await expect(
      datePicker.locator('input[type="date"], input[type="datetime-local"]'),
    ).toHaveCount(0);
    await expect(datePicker.locator('.cinder-date-picker__trigger').first()).toHaveAttribute(
      'aria-haspopup',
      'dialog',
    );
    await datePicker
      .getByRole('button', { name: /open .*calendar|open date picker/i })
      .first()
      .click();
    await expect(page.locator('.cinder-date-picker__panel')).toHaveCount(1);
    await expect(page.locator('.cinder-date-picker__panel')).toBeVisible();
    const rangePage = await componentPage.open({
      entry: rangeEntry,
      theme: 'light',
      viewport,
      fixtureName: 'assertion',
      fixtureContentHash: assertionHash(rangeEntry),
    });
    await expect(
      rangePage.locator(
        '.cinder-date-range-field input[type="date"], .cinder-date-range-field input[type="datetime-local"]',
      ),
    ).toHaveCount(0);
  });
});
