/// <reference lib="dom" />
/**
 * COR-2444 (from COR-2323): an Inspector is a right rail at desktop and tablet width and a section
 * under the content on a phone, and the record-details rows follow it. At 1280 and 768 the rail
 * sits beside the content on its tinted group, each InspectorRow's label beside its value; at 375
 * the rail is a section under the content on the raised surface, each label above its value. The
 * content's framed DescriptionList `fields` record stacks by its own width (below 23rem): beside
 * its value at 1280 and at 768, where it is 386px wide, stacked at 375, where it is 357px; it takes
 * the Inspector's surface at each width, and its linked row's chevron lands where an InspectorRow's
 * does. Measured on the Inspector `detail-page` fixture; every box is read in one pass.
 */

import { fixtureRoute } from '@lostgradient/testing/playwright/overlay-fixture';
import { expect, test, type Page } from '@playwright/test';

type Box = { top: number; bottom: number; left: number; right: number; width: number };

async function measure(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(fixtureRoute('inspector', { fixtureName: 'detail-page' }), { waitUntil: 'load' });
  await page.locator('.cinder-inspector-row').first().waitFor({ state: 'visible' });
  return page.evaluate(() => {
    const box = (element: Element | null | undefined): Box | null => {
      if (!element) return null;
      const { top, bottom, left, right, width: boxWidth } = element.getBoundingClientRect();
      return { top, bottom, left, right, width: boxWidth };
    };
    const background = (token: string) => {
      const probe = document.createElement('div');
      probe.style.background = `var(${token})`;
      document.body.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    };
    const row = document.querySelector('.cinder-inspector-row');
    const group = document.querySelector('.cinder-inspector__group');
    const facts = document.querySelector('[data-testid="inspector-detail-facts"]');
    const [linkedFact] = facts?.querySelectorAll('.cinder-description-list__row') ?? [];
    return {
      content: box(document.querySelector('[data-testid="inspector-detail-content"]')),
      rail: box(document.querySelector('[data-testid="inspector-detail-rail"]')),
      row: box(row),
      label: box(row?.querySelector('.cinder-inspector-row__label')),
      value: box(row?.querySelector('.cinder-inspector-row__value')),
      chevron: box(row?.querySelector('.cinder-inspector-row__chevron svg')),
      groupBackground: group ? getComputedStyle(group).backgroundColor : null,
      inset: background('--cinder-surface-inset'),
      raised: background('--cinder-surface-raised'),
      facts: box(facts),
      factsBackground: facts ? getComputedStyle(facts).backgroundColor : null,
      factRow: box(linkedFact),
      factTerm: box(linkedFact?.querySelector('dt')),
      factValue: box(linkedFact?.querySelector('.cinder-description-list__definition')),
      factChevron: box(linkedFact?.querySelector('.cinder-description-list__link svg')),
    };
  });
}

for (const width of [1280, 768]) {
  test(`at ${width} the Inspector is a tinted right rail with each label beside its value`, async ({
    page,
  }) => {
    const read = await measure(page, width);
    const { content, rail, row, label, value, chevron, facts } = read;
    const { factRow, factTerm, factValue, factChevron } = read;

    // The rail: beside the content, at its inline end, on the tinted group.
    expect(rail!.left).toBeGreaterThanOrEqual(content!.right);
    expect(rail!.top).toBeLessThan(content!.bottom);
    expect(rail!.width).toBeLessThan(content!.width);
    expect(read.groupBackground).toBe(read.inset);

    // Each row: the label in its 140px column, the value beside it on the same line.
    expect(value!.left).toBeGreaterThanOrEqual(label!.left + 139);
    expect(value!.top).toBeLessThan(label!.bottom);
    expect(value!.bottom).toBeGreaterThan(label!.top);

    // The fields record is at least 23rem wide (386px at 768): its term sits beside its value, on
    // the Inspector's tint, and the linked row's chevron is as far from the row's end as an
    // InspectorRow's.
    expect(facts!.width).toBeGreaterThan(368);
    expect(read.factsBackground).toBe(read.inset);
    expect(factValue!.left).toBeGreaterThanOrEqual(factTerm!.left + 139);
    expect(factValue!.top).toBeLessThan(factTerm!.bottom);
    expect(factChevron!.left).toBeGreaterThanOrEqual(factValue!.left);
    expect(
      Math.abs(factRow!.right - factChevron!.right - (row!.right - chevron!.right)),
    ).toBeLessThan(1);
  });
}

test('on a phone the Inspector is a raised section under the content with each label above its value', async ({
  page,
}) => {
  const read = await measure(page, 375);
  const { content, rail, label, value, facts, factTerm, factValue } = read;

  // The section: under the content, as wide as it.
  expect(rail!.top).toBeGreaterThanOrEqual(content!.bottom);
  expect(Math.abs(rail!.left - content!.left)).toBeLessThan(1);
  expect(Math.abs(rail!.width - content!.width)).toBeLessThan(1);
  expect(read.groupBackground).toBe(read.raised);

  // Each row: the label stacks above its value.
  expect(value!.top).toBeGreaterThanOrEqual(label!.bottom - 1);
  expect(value!.left).toBeLessThan(label!.left + 1);

  // The fields record is narrower than 23rem (357px), so its term stacks above its value too, and
  // its framed group takes the Inspector's raised phone surface.
  expect(facts!.width).toBeLessThanOrEqual(357);
  expect(factValue!.top).toBeGreaterThanOrEqual(factTerm!.bottom - 1);
  expect(read.factsBackground).toBe(read.raised);
});
