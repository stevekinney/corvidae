/**
 * COR-1860: a run's steps, logs, related runs and checkpoint replay.
 *
 * - Steps are a list with a waterfall bar each, and the open step beside it with input and output
 *   side by side and the lines the run logged just before it ran. The whole log is under Details.
 * - Related runs, in the Details rail, list the run that started this one, the runs it started and
 *   the runs started alongside it, with a topology that opens in a drawer.
 * - A checkpoint's replay has no colored edge, and says it is a replay in an Alert.
 *
 * The runs are the seeded `logged-steps` run (`fixtures/run-steps.ts`) and its two children, on the
 * real Weft server; nothing is mocked.
 */
import type { APIRequestContext, Page } from '@playwright/test';

import { RUN_STEPS_RUN_ID } from '../../fixtures/run-steps-ids.ts';
import { expect, test } from './fixtures.ts';

const WIDTHS = [375, 768, 1280] as const;

interface TimelineStep {
  readonly step: number;
  readonly operationLabel: string;
}

async function timelineOf(request: APIRequestContext, runId: string): Promise<TimelineStep[]> {
  const response = await request.get(`/v1/workflows/${encodeURIComponent(runId)}/timeline`);
  expect(response.status()).toBe(200);
  return (await response.json()) as TimelineStep[];
}

async function openStep(page: Page, step: number): Promise<void> {
  // The row's attributes are on its button.
  await page.locator(`[data-step-row="${String(step)}"]`).click();
}

test('each step has a waterfall bar placed by its start, and the open step shows input and output side by side', async ({
  page,
  request,
  checkA11y,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const timeline = await timelineOf(request, RUN_STEPS_RUN_ID);
  expect(timeline.length).toBeGreaterThanOrEqual(3);

  await page.goto(`/runs/${RUN_STEPS_RUN_ID}`);
  await expect(page.getByRole('heading', { level: 3, name: 'Steps' })).toBeVisible();
  const rows = page.locator('[data-step-row]');
  await expect(rows).toHaveCount(timeline.length);

  // Every row has a bar on the same scale: inside the track, and starting no earlier than the
  // step before it.
  const bars = await page.locator('.ib-step-row__track').evaluateAll((tracks) =>
    tracks.map((track) => {
      const bar = track.querySelector<HTMLElement>('.ib-step-row__bar');
      const trackBox = track.getBoundingClientRect();
      const barBox = bar?.getBoundingClientRect();
      return {
        hasBar: bar !== null,
        offset: barBox === undefined ? -1 : barBox.left - trackBox.left,
        inside:
          barBox !== undefined &&
          barBox.left >= trackBox.left - 0.5 &&
          barBox.right <= trackBox.right + 0.5,
      };
    }),
  );
  expect(bars.every((bar) => bar.hasBar && bar.inside)).toBe(true);
  const offsets = bars.map((bar) => bar.offset);
  expect(offsets).toEqual(offsets.toSorted((a, b) => a - b));

  const first = timeline[0];
  if (first === undefined) throw new Error('The seeded run has no steps.');
  await openStep(page, first.step);
  const detail = page.locator('article[data-step]');
  await expect(detail).toBeVisible();
  await expect(detail.getByRole('heading', { level: 3 })).toBeVisible();
  await expect(detail.locator('.ib-step-detail__status')).toContainText('Succeeded');
  const input = await detail.getByRole('region', { name: 'Input' }).boundingBox();
  const output = await detail.getByRole('region', { name: 'Output' }).boundingBox();
  expect(input).not.toBeNull();
  expect(output).not.toBeNull();
  // Side by side: the same top, the output to the right of the input.
  expect(Math.abs((input?.y ?? 0) - (output?.y ?? 1))).toBeLessThan(2);
  expect(output?.x ?? 0).toBeGreaterThan((input?.x ?? 0) + (input?.width ?? 0) - 2);
  await checkA11y('run steps — a step open');
});

test('a step shows the lines logged just before it, and the whole log is under Details', async ({
  page,
  request,
}) => {
  const timeline = await timelineOf(request, RUN_STEPS_RUN_ID);
  const [firstStep, secondStep] = timeline;
  if (firstStep === undefined || secondStep === undefined) throw new Error('Too few steps seeded.');
  await page.goto(`/runs/${RUN_STEPS_RUN_ID}`);

  await openStep(page, firstStep.step);
  const detail = page.locator('article[data-step]');
  await expect(detail.getByText('run started')).toBeVisible();
  await expect(detail.getByText('prepared, about to settle')).toHaveCount(0);

  await openStep(page, secondStep.step);
  await expect(detail.getByText('prepared, about to settle')).toBeVisible();
  await expect(detail.getByText('run started')).toHaveCount(0);

  // The whole log, in the rail: it includes the line logged after the last step, which no step shows.
  const logs = page.locator('[data-section="logs"]');
  await logs.getByRole('button', { name: /^Logs/ }).click();
  const lines = logs.getByRole('list', { name: 'Log lines' }).getByRole('listitem');
  await expect(lines).toHaveCount(4);
  await expect(logs.getByText('finished after the last step')).toBeVisible();
  await expect(page.getByText("Logs aren't available over the API")).toHaveCount(0);
});

test('Related runs list the runs a run started and, from a child, its parent and its sibling', async ({
  page,
  checkA11y,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/runs/${RUN_STEPS_RUN_ID}`);
  const related = page.locator('[data-section="related"]');
  await expect(related.getByRole('heading', { level: 2, name: 'Related runs' })).toBeVisible();
  const started = related.locator('[data-group="Started"]');
  await expect(started.locator('[data-related-run]')).toHaveCount(2);
  await expect(started).toContainText('logged-step-child');
  await expect(related.locator('[data-group="Started by"]')).toHaveCount(0);
  // It sits in the Details rail, under the facts.
  const rail = page.getByRole('complementary', { name: 'Details' });
  await expect(rail.locator('[data-section="related"]')).toBeVisible();

  // The children are read from the page, by the identifier each related run carries.
  const child = await started
    .locator('[data-related-run]')
    .first()
    .getAttribute('data-related-run');
  if (child === null) throw new Error('The seeded run started no children.');
  await page.goto(`/runs/${child}`);
  const fromChild = page.locator('[data-section="related"]');
  await expect(fromChild.locator('[data-group="Started by"]')).toContainText('logged-steps');
  const siblings = fromChild.locator('[data-group="Started alongside"]');
  await expect(siblings.locator('[data-related-run]')).toHaveCount(1);
  await expect(siblings.locator(`[data-related-run="${child}"]`)).toHaveCount(0);

  await fromChild.getByRole('button', { name: 'Topology' }).click();
  const tree = page.getByTestId('run-topology');
  await expect(tree).toBeVisible();
  await expect(tree.locator('li')).toHaveCount(3);
  await expect(tree.locator('[data-current]')).toContainText('This run');
  await checkA11y('run — topology drawer open');
});

test('a checkpoint opens as a replay with an Alert and no colored edge', async ({
  page,
  checkA11y,
}) => {
  await page.goto('/workflows/order-processing/runs');
  await page
    .getByRole('row', { name: /order-processing/ })
    .first()
    .getByRole('link')
    .click();
  await page.getByRole('button', { name: 'Checkpoints' }).click();
  const list = page.locator('.weft-checkpoints-tab__list');
  await expect(list).toBeVisible();
  await list.locator('.weft-checkpoints-tab__row').first().click();

  const frame = page.locator('.weft-replay-view');
  await expect(frame.getByRole('alert')).toContainText('This is a replay of step');
  await expect(frame).not.toContainText(/eager|loaded code/i);
  // One segmented control for Replay and Fork.
  await expect(page.getByRole('radio', { name: 'Replay' })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Fork' })).not.toBeChecked();
  // No stripe: the four borders of the frame are the same width.
  const widths = await frame.evaluate((element) => {
    const style = getComputedStyle(element);
    return [
      style.borderInlineStartWidth,
      style.borderInlineEndWidth,
      style.borderBlockStartWidth,
      style.borderBlockEndWidth,
    ];
  });
  expect(new Set(widths).size).toBe(1);
  await checkA11y('run — checkpoint replay');
});

test('the steps, logs and related runs do not scroll sideways at 375, 768 and 1280 pixels', async ({
  page,
  request,
}) => {
  const timeline = await timelineOf(request, RUN_STEPS_RUN_ID);
  const [firstStep] = timeline;
  if (firstStep === undefined) throw new Error('The seeded run has no steps.');
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/runs/${RUN_STEPS_RUN_ID}?step=${String(firstStep.step)}`);
    await expect(page.locator('article[data-step]')).toBeVisible();
    await page.locator('[data-section="logs"]').getByRole('button', { name: /^Logs/ }).click();
    await expect(
      page.locator('[data-section="logs"]').getByText('finished after the last step'),
    ).toBeVisible();
    const sideways = await page.evaluate(() => {
      const root = document.documentElement;
      const outlet = document.querySelector('main');
      return (
        root.scrollWidth > root.clientWidth ||
        (outlet !== null && outlet.scrollWidth > outlet.clientWidth)
      );
    });
    expect(sideways, `at ${String(width)}px`).toBe(false);
  }
});
