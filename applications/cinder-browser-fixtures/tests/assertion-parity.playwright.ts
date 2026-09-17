import { readFileSync } from 'node:fs';

import { loadManifest, VIEWPORTS } from '@repo/testing';

import { expect, test } from './component-page-fixture.ts';

const entries = loadManifest();

function assertionHash(entry: (typeof entries)[number]): string {
  const hash = entry.fixtures?.find((fixture) => fixture.name === 'assertion')?.fixtureContentHash;
  if (hash === undefined) throw new Error(`Assertion fixture hash missing for ${entry.slug}.`);
  return hash;
}

test.describe('table scroll recipe', () => {
  test('keeps the semantic table in a horizontally scrollable wrapper with sticky header', async ({
    page,
  }) => {
    const tableCss = readFileSync(
      new URL('../../../packages/cinder/src/components/table/table.css', import.meta.url),
      'utf8',
    ).replaceAll(/^@import\s+[^;]+;\s*$/gm, '');

    await page.setContent(`
      <style>
        :root {
          --cinder-text-sm: 14px;
          --cinder-text-default: #111827;
          --cinder-text-muted: #4b5563;
          --cinder-surface: #ffffff;
          --cinder-surface-inset: #f9fafb;
          --cinder-border-muted: #d1d5db;
          --cinder-space-1: 0.25rem;
          --cinder-space-2: 0.5rem;
          --cinder-space-3: 0.75rem;
          --cinder-font-medium: 500;
        }
        ${tableCss}
        .fixture-scroll {
          inline-size: 260px;
          block-size: 140px;
          overflow: auto;
          border: 1px solid var(--cinder-border-muted);
        }
        .fixture-scroll .cinder-table {
          inline-size: 720px;
        }
        .fixture-scroll th,
        .fixture-scroll td {
          min-inline-size: 180px;
        }
      </style>
      <div class="fixture-scroll cinder-table-scroll" data-testid="table-scroll">
        <table class="cinder-table" data-cinder-sticky-header>
          <caption class="cinder-table__caption">Builds</caption>
          <thead class="cinder-table__header">
            <tr class="cinder-table__row">
              <th class="cinder-table__header-cell" scope="col">Project</th>
              <th class="cinder-table__header-cell" scope="col">Owner</th>
              <th class="cinder-table__header-cell" scope="col">Status</th>
              <th class="cinder-table__header-cell" scope="col">Updated</th>
            </tr>
          </thead>
          <tbody class="cinder-table__body">
            ${Array.from(
              { length: 16 },
              (_, index) => `
                <tr class="cinder-table__row">
                  <td class="cinder-table__cell">Package ${index}</td>
                  <td class="cinder-table__cell">Design Systems</td>
                  <td class="cinder-table__cell">Passing</td>
                  <td class="cinder-table__cell">Today</td>
                </tr>
              `,
            ).join('')}
          </tbody>
        </table>
      </div>
    `);

    const wrapper = page.getByTestId('table-scroll');
    const table = wrapper.locator('table.cinder-table');
    await expect(table).toHaveJSProperty('tagName', 'TABLE');

    const wrapperSizes = await wrapper.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));

    expect(wrapperSizes.scrollWidth).toBeGreaterThan(wrapperSizes.clientWidth);
    expect(wrapperSizes.scrollHeight).toBeGreaterThan(wrapperSizes.clientHeight);

    const header = wrapper.locator('.cinder-table__header');
    await expect(header).toHaveCSS('position', 'sticky');
    const wrapperBox = await wrapper.boundingBox();
    const before = await header.boundingBox();
    await wrapper.evaluate((element) => {
      element.scrollTop = 80;
      element.scrollLeft = 120;
    });
    await page.waitForTimeout(50);
    const after = await header.boundingBox();

    expect(wrapperBox).not.toBeNull();
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(after?.y ?? 0).toBeLessThan(before?.y ?? 0);
    expect(Math.abs((after?.y ?? 0) - (wrapperBox?.y ?? 0))).toBeLessThan(2);
  });
});

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
    expect(Math.abs(inputBox!.x + inputBox!.width - incrementBox!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(incrementBox!.x + incrementBox!.width - decrementBox!.x)).toBeLessThanOrEqual(
      1,
    );
    expect(
      Math.abs(decrementBox!.x + decrementBox!.width - (groupBox!.x + groupBox!.width)),
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
