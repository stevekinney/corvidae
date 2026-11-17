/// <reference lib="dom" />
/**
 * COR-2444 (from COR-2323): an Inspector is a right rail at desktop width and a section under the
 * content on a phone, and the record-details rows follow it. At 1280 the rail sits beside the
 * content on its tinted group, each InspectorRow's label beside its value; at 375 the rail is a
 * section under the content on the raised surface, each label above its value. The content's
 * DescriptionList `fields` record does the same by its own width (700px): beside at 1280, stacked
 * at 375, with its linked row ending in a chevron at the row's inline end. Measured on the
 * Inspector `detail-page` fixture; every box is read in one pass.
 */

import { expect, test, type Page } from '@playwright/test';
import { fixtureRoute } from './overlay-fixture.ts';

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
      label: box(row?.querySelector('.cinder-inspector-row__label')),
      value: box(row?.querySelector('.cinder-inspector-row__value')),
      groupBackground: group ? getComputedStyle(group).backgroundColor : null,
      inset: background('--cinder-surface-inset'),
      raised: background('--cinder-surface-raised'),
      factRow: box(linkedFact),
      factTerm: box(linkedFact?.querySelector('dt')),
      factValue: box(linkedFact?.querySelector('.cinder-description-list__definition')),
      factChevron: box(linkedFact?.querySelector('.cinder-description-list__link svg')),
    };
  });
}

test('at desktop width the Inspector is a tinted right rail with each label beside its value', async ({
  page,
}) => {
  const read = await measure(page, 1280);
  const { content, rail, label, value, factRow, factTerm, factValue, factChevron } = read;

  // The rail: beside the content, at its inline end, on the tinted group.
  expect(rail!.left).toBeGreaterThanOrEqual(content!.right);
  expect(rail!.top).toBeLessThan(content!.bottom);
  expect(rail!.width).toBeLessThan(content!.width);
  expect(read.groupBackground).toBe(read.inset);

  // Each row: the label in its 140px column, the value beside it on the same line.
  expect(value!.left).toBeGreaterThanOrEqual(label!.left + 139);
  expect(value!.top).toBeLessThan(label!.bottom);
  expect(value!.bottom).toBeGreaterThan(label!.top);

  // The content's fields record is wider than 700px: its term sits beside its value, and the
  // linked row's chevron sits at the row's inline end, after the value.
  expect(factValue!.left).toBeGreaterThanOrEqual(factTerm!.left + 139);
  expect(factValue!.top).toBeLessThan(factTerm!.bottom);
  expect(factChevron!.left).toBeGreaterThanOrEqual(factValue!.left);
  expect(factRow!.right - factChevron!.right).toBeLessThan(24);
});

test('on a phone the Inspector is a raised section under the content with each label above its value', async ({
  page,
}) => {
  const read = await measure(page, 375);
  const { content, rail, label, value, factTerm, factValue } = read;

  // The section: under the content, as wide as it.
  expect(rail!.top).toBeGreaterThanOrEqual(content!.bottom);
  expect(Math.abs(rail!.left - content!.left)).toBeLessThan(1);
  expect(Math.abs(rail!.width - content!.width)).toBeLessThan(1);
  expect(read.groupBackground).toBe(read.raised);

  // Each row: the label stacks above its value.
  expect(value!.top).toBeGreaterThanOrEqual(label!.bottom - 1);
  expect(value!.left).toBeLessThan(label!.left + 1);

  // The content's fields record is narrower than 700px, so its term stacks above its value too.
  expect(factValue!.top).toBeGreaterThanOrEqual(factTerm!.bottom - 1);
});
