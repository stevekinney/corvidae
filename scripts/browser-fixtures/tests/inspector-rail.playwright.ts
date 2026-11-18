/// <reference lib="dom" />
/**
 * COR-2444 (from COR-2323), with COR-2394's container queries: an Inspector and a framed
 * DescriptionList `fields` record follow their own width, not the viewport's (owner, 2026-11-16 and
 * 2026-11-18). Below 700px of its own width an Inspector sits on the raised group with each
 * InspectorRow's label above its value; at 700px or wider it is the tinted group with each label
 * beside its value. A framed fields record takes the same surface by the same width.
 *
 * The `detail-page` fixture puts the Inspector in a 20rem rail beside the content at 1280 and 768,
 * and under the content at 375: the rail is narrower than 700px at every width, so it is stacked
 * and raised at all three. The `wide` fixture puts it under the content at the page's full width,
 * so at 1280 it is beside-and-tinted, as is the framed record beside it, whose linked row's chevron
 * lands where an InspectorRow's does. The fields record stacks its own rows below 23rem: beside its
 * value at 1280 and 768 (386px wide), stacked at 375 (357px). Every box is read in one pass.
 */

import { expect, test, type Page } from '@playwright/test';
import { fixtureRoute } from './overlay-fixture.ts';

type Box = { top: number; bottom: number; left: number; right: number; width: number };

async function measure(page: Page, width: number, fixtureName: 'detail-page' | 'wide') {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(fixtureRoute('inspector', { fixtureName }), { waitUntil: 'load' });
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
      inspector: box(document.querySelector('.cinder-inspector')),
      row: box(row),
      label: box(row?.querySelector('.cinder-inspector-row__label')),
      value: box(row?.querySelector('.cinder-inspector-row__value')),
      chevron: box(row?.querySelector('.cinder-inspector-row__chevron svg')),
      groupBackground: group ? getComputedStyle(group).backgroundColor : null,
      inset: background('--cinder-surface-inset'),
      raised: background('--cinder-surface-raised'),
      facts: box(facts),
      // A framed record paints its group fill on a pseudo-element, so a container query can switch it.
      factsBackground: facts ? getComputedStyle(facts, '::before').backgroundColor : null,
      factRow: box(linkedFact),
      factTerm: box(linkedFact?.querySelector('dt')),
      factValue: box(linkedFact?.querySelector('.cinder-description-list__definition')),
      factChevron: box(linkedFact?.querySelector('.cinder-description-list__link svg')),
    };
  });
}

type Reading = Awaited<ReturnType<typeof measure>>;

/** Each InspectorRow's label stacks above its value, on the raised group. */
function expectStackedRaised(read: Reading) {
  expect(read.inspector!.width).toBeLessThan(700);
  expect(read.groupBackground).toBe(read.raised);
  expect(read.value!.top).toBeGreaterThanOrEqual(read.label!.bottom - 1);
  expect(read.value!.left).toBeLessThan(read.label!.left + 1);
}

for (const width of [1280, 768]) {
  test(`at ${width} the Inspector is a right rail, narrower than 700px, stacked on the raised group`, async ({
    page,
  }) => {
    const read = await measure(page, width, 'detail-page');
    const { content, rail, facts, factTerm, factValue } = read;

    // The rail: beside the content, at its inline end.
    expect(rail!.left).toBeGreaterThanOrEqual(content!.right);
    expect(rail!.top).toBeLessThan(content!.bottom);
    expect(rail!.width).toBeLessThan(content!.width);
    expectStackedRaised(read);

    // The fields record is at least 23rem wide (386px at 768), so its term sits beside its value.
    // Its surface follows its own width as the Inspector's does: tinted at 700px or wider, raised
    // below.
    expect(facts!.width).toBeGreaterThan(368);
    expect(factValue!.left).toBeGreaterThanOrEqual(factTerm!.left + 139);
    expect(factValue!.top).toBeLessThan(factTerm!.bottom);
    expect(read.factsBackground).toBe(facts!.width >= 700 ? read.inset : read.raised);
  });
}

test('on a phone the Inspector is a raised section under the content with each label above its value', async ({
  page,
}) => {
  const read = await measure(page, 375, 'detail-page');
  const { content, rail, facts, factTerm, factValue } = read;

  // The section: under the content, as wide as it.
  expect(rail!.top).toBeGreaterThanOrEqual(content!.bottom);
  expect(Math.abs(rail!.left - content!.left)).toBeLessThan(1);
  expect(Math.abs(rail!.width - content!.width)).toBeLessThan(1);
  expectStackedRaised(read);

  // The fields record is narrower than 23rem (357px), so its term stacks above its value too, and
  // its framed group takes the Inspector's raised surface.
  expect(facts!.width).toBeLessThanOrEqual(357);
  expect(factValue!.top).toBeGreaterThanOrEqual(factTerm!.bottom - 1);
  expect(read.factsBackground).toBe(read.raised);
});

test('at 1280 a full-width Inspector is the tinted group with each label beside its value', async ({
  page,
}) => {
  const read = await measure(page, 1280, 'wide');
  const { inspector, row, label, value, chevron, facts } = read;
  const { factRow, factTerm, factValue, factChevron } = read;

  // The Inspector is 700px or wider: the tinted group, each label in its 140px column with the
  // value beside it on the same line.
  expect(inspector!.width).toBeGreaterThanOrEqual(700);
  expect(read.groupBackground).toBe(read.inset);
  expect(value!.left).toBeGreaterThanOrEqual(label!.left + 139);
  expect(value!.top).toBeLessThan(label!.bottom);
  expect(value!.bottom).toBeGreaterThan(label!.top);

  // The framed record beside it is as wide and agrees: the tint, its term beside its value, and the
  // linked row's chevron as far from the row's end as an InspectorRow's.
  expect(facts!.width).toBeGreaterThanOrEqual(700);
  expect(read.factsBackground).toBe(read.inset);
  expect(factValue!.left).toBeGreaterThanOrEqual(factTerm!.left + 139);
  expect(factValue!.top).toBeLessThan(factTerm!.bottom);
  expect(factChevron!.left).toBeGreaterThanOrEqual(factValue!.left);
  expect(
    Math.abs(factRow!.right - factChevron!.right - (row!.right - chevron!.right)),
  ).toBeLessThan(1);
});
