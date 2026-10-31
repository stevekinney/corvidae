/**
 * `/workflows/:workflow/run` against the real host: the workflow is fixed by the address, the
 * input is a form drawn from the file's schema, an invalid input shows its field errors and
 * creates no run, and plain Enter never starts one. Start run on the workflow page and on Runs
 * (through the picker) reaches the page, and On a schedule creates a schedule in the chosen zone.
 */
import type { Page } from '@playwright/test';
import { rm } from 'node:fs/promises';

import { WORKFLOW_COPY } from '../../src/app/copy.ts';
import { bureau } from './agent-support.ts';
import { expect, test } from './fixtures.ts';
import { expectEngineMissesForFileRuns } from './task-support.ts';
import {
  createWorkflowFile,
  listWorkflowRuns,
  removeWorkflow,
  workflowFilePath,
  workflowRunStatus,
} from './workflow-support.ts';

const COPY = WORKFLOW_COPY.runSetup;
const WIDTHS = [375, 1280] as const;

const area = (page: Page) => page.locator('[data-view="workflows"]');
const setup = (page: Page) => page.locator('[data-page="run-setup"]');
const footer = (page: Page) => setup(page).getByTestId('run-setup-footer');

/** Identifiers this file's specs create, removed after each spec. */
const created = new Set<string>();
/** Schedules this file's specs create, cancelled after each spec. */
const schedules = new Set<string>();

test.afterEach(async ({ request }) => {
  for (const id of created) {
    await removeWorkflow(request, id);
    await rm(await workflowFilePath(request, id), { force: true });
  }
  created.clear();
  for (const id of schedules) await request.delete(`/v1/schedules/${encodeURIComponent(id)}`);
  schedules.clear();
});

/** A file that waits for a signal, so a started instance stays running until the spec ends it. */
async function createWaiting(
  request: Parameters<typeof createWorkflowFile>[0],
  id: string,
): Promise<void> {
  created.add(id);
  await createWorkflowFile(request, id, {
    trigger: { kind: 'signal', name: `${id}-go` },
    steps: [{ kind: 'await-signal', signal: `${id}-wait` }],
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', title: 'Topic', minLength: 3 },
        count: { type: 'integer', title: 'Count' },
      },
      required: ['topic'],
    },
  });
}

async function finish(
  request: Parameters<typeof createWorkflowFile>[0],
  id: string,
  runId: string,
): Promise<void> {
  await expect
    .poll(async () => {
      await bureau(request, 'bureau.workflows.signal', { name: `${id}-wait` });
      return workflowRunStatus(request, runId);
    })
    .toBe('completed');
}

test.describe('the run setup page', () => {
  test('names the workflow, lays out Input and When, and pins the action', async ({
    page,
    request,
    checkA11y,
  }) => {
    const id = 'e2e-setup-layout';
    await createWaiting(request, id);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/workflows/${id}/run`);
      await expect(area(page)).toHaveAttribute('data-state', 'ready');
      await expect(page.getByRole('heading', { level: 1, name: COPY.title(id) })).toBeVisible();
      await expect(setup(page).getByRole('heading', { level: 2 })).toHaveText([
        COPY.inputHeading,
        COPY.whenHeading,
      ]);
      await expect(setup(page).getByLabel('Topic')).toBeVisible();
      await expect(footer(page).getByTestId('run-setup-summary')).toHaveText(COPY.summaryNow(id));
      await expect(footer(page).getByRole('button', { name: COPY.startAction })).toBeVisible();
      await checkA11y(`run setup at ${width}px`);
    }
  });

  test('shows the field errors of an invalid input and creates no run', async ({
    page,
    request,
  }) => {
    const id = 'e2e-setup-invalid';
    await createWaiting(request, id);
    await page.goto(`/workflows/${id}/run`);
    await expect(area(page)).toHaveAttribute('data-state', 'ready');
    await setup(page).getByLabel('Topic').fill('ab');
    await footer(page).getByRole('button', { name: COPY.startAction }).click();
    await expect(setup(page).getByLabel('Topic')).toHaveAttribute('aria-invalid', 'true');
    await expect(page).toHaveURL(new RegExp(`/workflows/${id}/run$`));
    expect(await listWorkflowRuns(request, id)).toEqual([]);
  });

  test('does not start on Enter, and starts from the footer with the input', async ({
    page,
    request,
    pageErrors,
  }) => {
    const id = 'e2e-setup-start';
    await createWaiting(request, id);
    await page.goto(`/workflows/${id}/run`);
    await expect(area(page)).toHaveAttribute('data-state', 'ready');
    const topic = setup(page).getByLabel('Topic');
    await topic.fill('weather');
    await topic.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/workflows/${id}/run$`));
    expect(await listWorkflowRuns(request, id)).toEqual([]);

    expectEngineMissesForFileRuns(pageErrors);
    await footer(page).getByRole('button', { name: COPY.startAction }).click();
    await expect(page).toHaveURL(new RegExp(`/workflows/${id}/runs/[^/]+$`));
    const [run] = await listWorkflowRuns(request, id);
    expect(run?.status).toBe('running');
    // One run, which took the input the form held, from the web surface.
    expect(await listWorkflowRuns(request, id)).toHaveLength(1);
    const started = await bureau(request, 'bureau.workflows.runs.get', { runId: run?.id });
    expect((started.result as { trigger: unknown }).trigger).toMatchObject({
      kind: 'manual',
      input: { topic: 'weather' },
      origin: { surface: 'web' },
    });
    if (run !== undefined) await finish(request, id, run.id);
  });

  test('Cancel returns to the workflow', async ({ page, request }) => {
    const id = 'e2e-setup-cancel';
    await createWaiting(request, id);
    await page.goto(`/workflows/${id}/run`);
    await expect(area(page)).toHaveAttribute('data-state', 'ready');
    await footer(page).getByRole('button', { name: COPY.cancel }).click();
    await expect(page).toHaveURL(new RegExp(`/workflows/${id}$`));
  });
});

test.describe('reaching the page', () => {
  test('Start run on the workflow page opens it', async ({ page, request }) => {
    const id = 'e2e-setup-header';
    await createWaiting(request, id);
    await page.goto(`/workflows/${id}`);
    await expect(area(page)).toHaveAttribute('data-state', 'ready');
    await page
      .locator('[data-page="workflow-detail"]')
      .getByRole('link', { name: WORKFLOW_COPY.page.startAction })
      .click();
    await expect(page).toHaveURL(new RegExp(`/workflows/${id}/run$`));
    await expect(setup(page).getByLabel('Topic')).toBeVisible();
  });

  test('Start run on Runs picks a workflow, then opens its page', async ({ page, request }) => {
    const id = 'e2e-setup-picker';
    await createWaiting(request, id);
    await page.goto('/runs');
    await page.getByRole('link', { name: 'Start run' }).click();
    await expect(page).toHaveURL(/\/runs\?view=start$/);
    await page
      .getByRole('list', { name: WORKFLOW_COPY.runPicker.listLabel })
      .getByRole('link', { name: id })
      .click();
    await expect(page).toHaveURL(new RegExp(`/workflows/${id}/run$`));
    await expect(page.getByRole('heading', { level: 1, name: COPY.title(id) })).toBeVisible();
  });
});

test.describe('on a schedule', () => {
  test('creates a schedule for a code-defined type in the chosen zone', async ({
    page,
    request,
  }) => {
    await page.goto('/workflows/order-processing/run');
    await expect(area(page)).toHaveAttribute('data-state', 'ready');
    await setup(page)
      .getByRole('radio', { name: new RegExp(COPY.schedule) })
      .click();
    await setup(page).getByLabel('Repeats', { exact: true }).selectOption('daily');
    await setup(page).getByLabel('At', { exact: true }).fill('03:00');
    await setup(page).getByRole('combobox', { name: 'Time zone' }).fill('America/Los_Angeles');
    await page.getByRole('option', { name: 'America/Los Angeles', exact: true }).click();
    await expect(footer(page).getByTestId('run-setup-summary')).toContainText(
      'in America/Los_Angeles',
    );
    await footer(page).getByRole('button', { name: COPY.scheduleAction }).click();
    await expect(page).toHaveURL(/\/schedules\/[^/?]+$/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Schedule for order-processing' }),
    ).toBeVisible();
    const id = decodeURIComponent(new URL(page.url()).pathname.split('/').pop() ?? '');
    schedules.add(id);
    // The schedule the engine holds reads 3:00 in the zone that was chosen.
    const listed = await request.get('/v1/schedules');
    const { items } = (await listed.json()) as {
      items: { id: string; cronExpression?: string; timeZone?: string }[];
    };
    expect(items.find((item) => item.id === id)).toMatchObject({
      cronExpression: '0 3 * * *',
      timeZone: 'America/Los_Angeles',
    });
  });

  test('is not offered for a file, whose schedule is its trigger', async ({ page, request }) => {
    const id = 'e2e-setup-file-schedule';
    await createWaiting(request, id);
    await page.goto(`/workflows/${id}/run`);
    await expect(area(page)).toHaveAttribute('data-state', 'ready');
    await expect(setup(page).getByRole('radio', { name: new RegExp(COPY.schedule) })).toHaveCount(
      0,
    );
    await expect(setup(page).getByText(COPY.scheduleInFile)).toBeVisible();
  });
});
