/**
 * COR-1966: `/runs/:run` as one page. One header with one status and no tabs; a waiting question
 * first, answered where it is asked; Input and output, Activity, and a "Change or ask this run"
 * section whose forms open in place, with no dialog; and a 320 px Details rail with each label above
 * its value. It fits at 375, 768 and 1280 pixels, and the engine's sections are there for a caller
 * who may read the workflow, each gated on its own scope.
 *
 * The runs come from the seeded real Weft server (`fixtures/engine-console.ts`) and the Bureau's own
 * tasks; nothing is mocked.
 */
import type { Page } from '@playwright/test';

import {
  ATTRIBUTE_SHOWCASE_RUN_ID,
  UPDATE_DESK_RUN_ID,
} from '../../fixtures/engine-console-ids.ts';
import { newThreadId, runToEnd } from './chat-support.ts';
import { expect, test } from './fixtures.ts';
import { expectEngineMissesForTasks, taskOfSession } from './task-support.ts';

const WIDTHS = [375, 768, 1280] as const;

/** Whether the page, or the shell's outlet, scrolls sideways. */
async function scrollsSideways(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const root = document.documentElement;
    const outlet = document.querySelector('main');
    return (
      root.scrollWidth > root.clientWidth ||
      (outlet !== null && outlet.scrollWidth > outlet.clientWidth)
    );
  });
}

test('a run is one header with one status and no tabs, and its sections are on the page', async ({
  page,
  checkA11y,
}) => {
  await page.goto(`/runs/${ATTRIBUTE_SHOWCASE_RUN_ID}`);

  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.locator('[data-run-header] [data-status-word]')).toHaveCount(1);
  await expect(page.locator('[data-status-word]')).toHaveCount(1);
  await expect(page.getByRole('tab')).toHaveCount(0);
  for (const name of ['Input and output', 'Activity', 'Change or ask this run', 'Details']) {
    await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
  }
  await checkA11y('a run’s page');
});

test('the Details rail is 320 px beside the sections, with each label above its value', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/runs/${ATTRIBUTE_SHOWCASE_RUN_ID}`);

  const rail = page.getByRole('complementary', { name: 'Details' });
  await expect(rail).toBeVisible();
  const box = await rail.boundingBox();
  expect(box?.width).toBe(320);

  // A label sits above its value, not beside it: the value starts below the label's bottom edge.
  const term = rail.locator('dt').first();
  const definition = rail.locator('dd').first();
  const termBox = await term.boundingBox();
  const definitionBox = await definition.boundingBox();
  expect(termBox).not.toBeNull();
  expect(definitionBox).not.toBeNull();
  expect(definitionBox!.y).toBeGreaterThanOrEqual(termBox!.y + termBox!.height - 1);

  const main = page.getByRole('heading', { level: 2, name: 'Input and output' });
  const mainBox = await main.boundingBox();
  expect(mainBox!.x + mainBox!.width).toBeLessThanOrEqual(box!.x);
});

test('a run fits at 375, 768 and 1280 pixels, with the Details rail under the sections on a narrow screen', async ({
  page,
}) => {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/runs/${ATTRIBUTE_SHOWCASE_RUN_ID}`);
    await expect(page.getByRole('heading', { level: 2, name: 'Details' })).toBeVisible();
    expect(await scrollsSideways(page), `scrolls sideways at ${width}`).toBe(false);

    const rail = await page.getByRole('complementary', { name: 'Details' }).boundingBox();
    const sections = await page
      .getByRole('heading', { level: 2, name: 'Input and output' })
      .boundingBox();
    if (width < 1024) expect(rail!.y).toBeGreaterThan(sections!.y);
    else expect(rail!.y).toBeLessThanOrEqual(sections!.y + 40);
  }
});

test('a signal, an update and a query are sent from the section on the page, with no dialog', async ({
  page,
}) => {
  await page.goto(`/runs/${UPDATE_DESK_RUN_ID}`);
  const section = page.locator('[data-section="change"]');
  await expect(section).toBeVisible();

  await section.getByRole('button', { name: 'Send a signal' }).click();
  await section.getByLabel('Signal name').fill('ping');
  await section.getByRole('button', { name: 'Send signal', exact: true }).click();
  await expect(section.getByLabel('Signal name')).toHaveValue('');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await section.getByRole('button', { name: 'Ask a question' }).click();
  await section.getByLabel('Query name').fill('nothingAnswersThis');
  await section.getByRole('button', { name: 'Run', exact: true }).click();
  // The workflow has no such query, and whatever the server answers is read in the section.
  await expect(
    section.locator('.weft-send-tab__error, .weft-send-tab__result').first(),
  ).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await section.getByRole('button', { name: 'Send an update' }).click();
  await expect(section.getByLabel('Update name')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('a waiting question leads the page and is answered where it is asked', async ({
  page,
  pageErrors,
}) => {
  expectEngineMissesForTasks(pageErrors);
  const threadId = newThreadId('run-page-question');
  await runToEnd(page.request, 'request-human-input', threadId, 'Release it');
  const task = await taskOfSession(page.request, threadId);
  expect(task.status).toBe('input-required');

  await page.goto(`/runs/${task.id}`);

  // The question is the first section of the page, above Input and output.
  const sections = page.locator('[data-section]');
  await expect(sections.first()).toHaveAttribute('data-section', 'waiting');
  await expect(page.getByText('Which environment should the release go to?')).toBeVisible();

  await page.getByLabel('Your answer').fill('staging');
  await page.getByRole('button', { name: 'Send', exact: true }).click();

  await expect(page.locator('[data-run-header]').getByText('Done', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
