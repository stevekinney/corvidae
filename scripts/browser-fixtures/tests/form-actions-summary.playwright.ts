/// <reference lib="dom" />
/**
 * COR-2593: a FormActions start slot with the Agent editor's A2A explanation wraps before it
 * squeezes the saved status. The browser fixture holds actual 30rem and 45rem bars, so this test
 * measures the status text range and controls at both constrained widths in each color scheme.
 */

import { loadManifest } from '@lostgradient/testing';
import { test } from '@lostgradient/testing/playwright/component-page-fixture';
import { expect, type Locator } from '@playwright/test';

const entry = loadManifest().find((candidate) => candidate.slug === 'form-actions');
const fixture = entry?.fixtures?.find((candidate) => candidate.name === 'summary');

async function atInlineSize(bar: Locator, inlineSize: string): Promise<void> {
  await bar.evaluate((element, width) => {
    (element as HTMLElement).style.inlineSize = width;
  }, inlineSize);
}

async function expectReadableSummary(bar: Locator): Promise<void> {
  const geometry = await bar.evaluate((element) => {
    const actions = element.querySelector<HTMLElement>('.cinder-form-actions');
    const summary = element.querySelector<HTMLElement>('.cinder-form-actions__summary');
    const summaryText = element.querySelector<HTMLElement>('[data-testid="saved-summary"]');
    const start = element.querySelector<HTMLElement>('.cinder-form-actions__start');
    const end = element.querySelector<HTMLElement>('.cinder-form-actions__end');
    if (
      actions === null ||
      summary === null ||
      summaryText === null ||
      start === null ||
      end === null
    )
      throw new Error('The FormActions summary fixture did not render all layout regions.');

    const range = document.createRange();
    range.selectNodeContents(summaryText);
    const textRects = [...range.getClientRects()].filter((rect) => rect.width > 0);
    const box = (candidate: HTMLElement) => candidate.getBoundingClientRect();
    const actionBox = box(actions);
    const summaryBox = box(summary);
    const startBox = box(start);
    const endBox = box(end);
    return {
      actionWidth: actionBox.width,
      scrollWidth: actions.scrollWidth,
      textLines: textRects.length,
      textWidth: range.getBoundingClientRect().width,
      summaryWidth: summaryBox.width,
      startInside: startBox.left >= actionBox.left && startBox.right <= actionBox.right,
      endInside: endBox.left >= actionBox.left && endBox.right <= actionBox.right,
      separated: summaryBox.right <= startBox.left || summaryBox.bottom <= startBox.top,
    };
  });

  expect(geometry.textLines).toBe(1);
  expect(geometry.textWidth).toBeLessThanOrEqual(geometry.summaryWidth);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.actionWidth);
  expect(geometry.startInside).toBe(true);
  expect(geometry.endInside).toBe(true);
  expect(geometry.separated).toBe(true);
  await expect(bar.getByRole('switch', { name: 'Available over A2A' })).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Save' })).toBeVisible();
}

async function expectNoStartSummaryWraps(bar: Locator): Promise<void> {
  const geometry = await bar.evaluate((element) => {
    const actions = element.querySelector<HTMLElement>('.cinder-form-actions');
    const summary = element.querySelector<HTMLElement>('.cinder-form-actions__summary');
    const summaryText = element.querySelector<HTMLElement>('[data-testid="long-summary"]');
    if (actions === null || summary === null || summaryText === null)
      throw new Error('The no-start FormActions fixture did not render its summary.');

    const range = document.createRange();
    range.selectNodeContents(summaryText);
    return {
      actionWidth: actions.getBoundingClientRect().width,
      scrollWidth: actions.scrollWidth,
      lines: [...range.getClientRects()].filter((rect) => rect.width > 0).length,
      summaryWidth: summary.getBoundingClientRect().width,
      textWidth: range.getBoundingClientRect().width,
    };
  });

  expect(geometry.lines).toBeGreaterThan(1);
  expect(geometry.textWidth).toBeLessThanOrEqual(geometry.summaryWidth);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.actionWidth);
  await expect(bar.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Save' })).toBeVisible();
}

for (const theme of ['light', 'dark'] as const) {
  test(`FormActions keeps the saved summary readable beside a wrapping start slot (${theme})`, async ({
    componentPage,
  }) => {
    if (entry === undefined || fixture === undefined)
      throw new Error('No FormActions summary fixture.');
    const page = await componentPage.open({
      entry,
      theme,
      viewport: { name: 'desktop', width: 1280, height: 900 },
      fixtureName: 'summary',
      fixtureContentHash: fixture.fixtureContentHash,
    });
    const narrow = page.getByTestId('form-actions-30rem');
    const wide = page.getByTestId('form-actions-45rem');
    const noStart = page.getByTestId('form-actions-long-summary');
    await atInlineSize(narrow, '30rem');
    await atInlineSize(wide, '45rem');
    await atInlineSize(noStart, '28.25rem');
    await expectReadableSummary(narrow);
    await expectReadableSummary(wide);
    await expectNoStartSummaryWraps(noStart);
  });
}
