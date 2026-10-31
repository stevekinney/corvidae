/**
 * `/workflows/:workflow` by its tabs, against the real host: Overview (steps as rows, input and
 * output as field lists), Code (a file's source, or what a code-defined type registered), Runs, and
 * History. The tab is in the address, and Start run in the header starts a real instance. Each
 * tab meets axe at the two widths the application is built for.
 *
 * The host serves the engine's console from the fixtures' engine, which is not the Bureau's, so a
 * code-defined type of the fixtures' engine is not one the Bureau registered: its Code tab says
 * there is no source. The Bureau's own host (`E2E_BUREAU_URL`) registers `agentRun`, whose Code tab
 * shows the description and the contract it registered.
 */
import type { Page } from '@playwright/test';
import { rm } from 'node:fs/promises';

import { WORKFLOW_COPY } from '../../src/app/copy.ts';
import { bureau } from './agent-support.ts';
import { E2E_BUREAU_URL } from './e2e-constants.ts';
import { expect, loggedFailedResponse, test } from './fixtures.ts';
import {
  createWorkflowFile,
  listWorkflowRuns,
  removeWorkflow,
  SEEDED_WORKFLOWS,
  workflowFilePath,
  workflowRunStatus,
} from './workflow-support.ts';

const WIDTHS = [375, 1280] as const;
const TABS = WORKFLOW_COPY.page.tabs;

const area = (page: Page) => page.locator('[data-view="workflows"]');
const detail = (page: Page) => page.locator('[data-page="workflow-detail"]');
const tab = (page: Page, name: string) => detail(page).getByRole('tab', { name });

/** Identifiers this file's specs create, removed after each spec. */
const created = new Set<string>();

test.afterEach(async ({ request }) => {
  for (const id of created) {
    await removeWorkflow(request, id);
    await rm(await workflowFilePath(request, id), { force: true });
  }
  created.clear();
});

test.describe('the Overview tab', () => {
  for (const width of WIDTHS) {
    test(`lists the steps as rows and the input and output as field lists, at ${width} pixels`, async ({
      page,
      request,
      checkA11y,
    }) => {
      const id = 'e2e-page-schemas';
      created.add(id);
      await createWorkflowFile(request, id, {
        trigger: { kind: 'signal', name: 'e2e-page-schemas-go' },
        steps: [{ kind: 'await-signal', signal: 'e2e-page-schemas-wait' }],
        inputSchema: {
          type: 'object',
          required: ['topic'],
          properties: { topic: { type: 'string', description: 'What to write about.' } },
        },
        outputSchema: { type: 'object', properties: { summary: { type: 'string' } } },
      });
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/workflows/${id}`);
      await expect(area(page)).toHaveAttribute('data-state', 'ready');
      const root = detail(page);

      await expect(root.getByRole('tab')).toHaveText([
        TABS.overview,
        TABS.code,
        TABS.runs,
        TABS.history,
      ]);
      await expect(root.getByTestId('workflow-steps').getByRole('listitem')).toHaveCount(1);
      const input = root.getByTestId('workflow-input-schema');
      await expect(input).toContainText('Topic');
      await expect(input).toContainText('What to write about.');
      await expect(root.getByTestId('workflow-output-schema')).toContainText('Summary');
      // No inline status string stands in for an empty list.
      await expect(root.getByTestId('workflow-overview')).not.toContainText(/\bNone\b/);
      await checkA11y(`the Overview tab at ${width}px`);
    });
  }

  test('puts input and output side by side at 1280 pixels and stacks them at 375', async ({
    page,
  }) => {
    for (const [width, sideBySide] of [
      [1280, true],
      [375, false],
    ] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/workflows/${SEEDED_WORKFLOWS.digest}`);
      await expect(area(page)).toHaveAttribute('data-state', 'ready');
      const input = await detail(page).getByTestId('workflow-input-schema').boundingBox();
      const output = await detail(page).getByTestId('workflow-output-schema').boundingBox();
      expect(input).not.toBeNull();
      expect(output).not.toBeNull();
      if (input === null || output === null) return;
      expect(output.y < input.y + input.height).toBe(sideBySide);
    }
  });
});

test.describe('the Code tab', () => {
  for (const width of WIDTHS) {
    test(`shows a file as it is on disk, with an outline of its steps, at ${width} pixels`, async ({
      page,
      request,
      checkA11y,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/workflows/${SEEDED_WORKFLOWS.digest}`);
      await expect(area(page)).toHaveAttribute('data-state', 'ready');
      await tab(page, TABS.code).click();
      const root = detail(page);

      const file = await bureau(request, 'bureau.workflows.get', { id: SEEDED_WORKFLOWS.digest });
      const text = (file.result as { text: string }).text;
      await expect(root.getByTestId('workflow-file-source')).toContainText(
        text.split('\n')[1]?.trim() ?? '"name"',
      );
      await expect(root.getByTestId('workflow-outline').getByRole('listitem')).toHaveCount(2);
      await checkA11y(`the Code tab of a file at ${width}px`);
    });
  }

  test('shows what a code-defined type registered, and says it is not the code, on the Bureau’s host', async ({
    browser,
  }) => {
    const context = await browser.newContext({ baseURL: E2E_BUREAU_URL });
    const page = await context.newPage();
    try {
      await page.goto('/workflows/agentRun?tab=code');
      await expect(area(page)).toHaveAttribute('data-state', 'ready');
      const root = detail(page);
      await expect(root.getByTestId('workflow-code')).toContainText(
        WORKFLOW_COPY.page.code.codeNote,
      );
      await expect(root.getByTestId('workflow-code-source')).toContainText('agentRun');
      await expect(root.getByTestId('workflow-code')).not.toContainText(
        WORKFLOW_COPY.page.code.fileHeading,
      );
    } finally {
      await context.close();
    }
  });

  test('says there is no source for a type the Bureau did not register', async ({ page }) => {
    await page.goto('/workflows/inventory-sync-sweep?tab=code');
    await expect(area(page)).toHaveAttribute('data-state', 'ready');
    await expect(detail(page).getByTestId('workflow-code')).toContainText(
      WORKFLOW_COPY.page.code.unavailableTitle,
    );
  });
});

test.describe('the tab in the address', () => {
  test('is written when a tab opens, left off for the Overview, and read when the page loads', async ({
    page,
  }) => {
    await page.goto(`/workflows/${SEEDED_WORKFLOWS.digest}`);
    await expect(area(page)).toHaveAttribute('data-state', 'ready');
    await tab(page, TABS.runs).click();
    await expect(page).toHaveURL(/\?tab=runs$/);
    await page.reload();
    await expect(tab(page, TABS.runs)).toHaveAttribute('aria-selected', 'true');
    await tab(page, TABS.overview).click();
    await expect(page).not.toHaveURL(/tab=/);
  });
});

test.describe('the Runs tab', () => {
  test('is an empty state that offers Start run when nothing has run the workflow', async ({
    page,
    checkA11y,
  }) => {
    await page.goto(`/workflows/${SEEDED_WORKFLOWS.digest}?tab=runs`);
    const runs = detail(page).getByTestId('workflow-recent-runs');
    await expect(runs).toContainText(WORKFLOW_COPY.page.runs.emptyTitle);
    await expect(runs.getByRole('button', { name: WORKFLOW_COPY.page.startAction })).toBeVisible();
    await checkA11y('the Runs tab, empty');
  });
});

test.describe('Start run', () => {
  test('starts a real instance with the input, and opens it', async ({ page, request }) => {
    const id = 'e2e-page-start';
    created.add(id);
    await createWorkflowFile(request, id, {
      trigger: { kind: 'signal', name: 'e2e-page-start-go' },
      steps: [{ kind: 'await-signal', signal: 'e2e-page-start-wait' }],
    });
    await page.goto(`/workflows/${id}`);
    await expect(area(page)).toHaveAttribute('data-state', 'ready');
    await detail(page).getByRole('button', { name: WORKFLOW_COPY.page.startAction }).click();
    const dialog = page.getByRole('dialog');
    await dialog
      .getByRole('textbox', { name: WORKFLOW_COPY.startDialog.inputLabel })
      .fill('{ "topic": "weather" }');
    await dialog.getByRole('button', { name: WORKFLOW_COPY.startDialog.confirm }).click();

    await expect(page).toHaveURL(new RegExp(`/workflows/${id}/runs/[^/]+$`));
    const [run] = await listWorkflowRuns(request, id);
    expect(run?.status).toBe('running');
    // The instance took the input the dialog held, as JSON, and was started from the web surface.
    const started = await bureau(request, 'bureau.workflows.runs.get', { runId: run?.id });
    expect(started.fault).toBeUndefined();
    expect((started.result as { trigger: unknown }).trigger).toMatchObject({
      kind: 'manual',
      input: { topic: 'weather' },
      origin: { surface: 'web' },
    });

    // Let the instance finish, so it does not stay in the host.
    await expect
      .poll(async () => {
        await bureau(request, 'bureau.workflows.signal', { name: 'e2e-page-start-wait' });
        return run === undefined ? undefined : workflowRunStatus(request, run.id);
      })
      .toBe('completed');
  });

  test('answers a run’s page from the Bureau’s record when the console’s engine does not hold the run', async ({
    page,
    request,
    pageErrors,
  }) => {
    const id = 'e2e-page-record';
    created.add(id);
    await createWorkflowFile(request, id, {
      trigger: { kind: 'signal', name: 'e2e-page-record-go' },
      steps: [{ kind: 'await-signal', signal: 'e2e-page-record-wait' }],
    });
    const started = await bureau(request, 'bureau.workflows.start', { id, surface: 'web' });
    expect(started.fault).toBeUndefined();
    const { runId } = started.result as { runId: string };

    // The end-to-end host's console engine is a fixture engine, so it answers the page's read of a
    // workflow file's instance with a 404 (the Bureau's engine holds it). On a host whose console
    // engine is the Bureau's there is no such answer.
    pageErrors.expect({
      pattern: loggedFailedResponse(404, new RegExp(`/v1/workflows/${runId}`)),
      reason: 'the fixture console engine does not hold the Bureau’s workflow instances',
    });
    await page.goto(`/runs/${runId}`);

    const record = page.getByRole('region', { name: 'Run record' });
    await expect(record).toContainText(id);
    await expect(record.getByRole('link', { name: id })).toHaveAttribute(
      'href',
      `/workflows/${id}`,
    );
    await expect(page.getByText('No workflow found')).toHaveCount(0);

    // Let the instance finish, so it does not stay in the host.
    await expect
      .poll(async () => {
        await bureau(request, 'bureau.workflows.signal', { name: 'e2e-page-record-wait' });
        return workflowRunStatus(request, runId);
      })
      .toBe('completed');
  });

  test('is not offered for a paused file', async ({ page, request }) => {
    const id = 'e2e-page-paused';
    created.add(id);
    await createWorkflowFile(request, id, { paused: true });
    await page.goto(`/workflows/${id}`);
    await expect(area(page)).toHaveAttribute('data-state', 'ready');
    await expect(
      detail(page).getByRole('button', { name: WORKFLOW_COPY.page.startAction }),
    ).toHaveCount(0);
    await expect(
      detail(page).getByRole('button', { name: WORKFLOW_COPY.resumeAction }),
    ).toBeVisible();
  });
});

test.describe('the History tab', () => {
  test('shows each version’s verdict against the current revision', async ({ page, request }) => {
    const id = 'e2e-page-history';
    created.add(id);
    await createWorkflowFile(request, id, {
      trigger: { kind: 'signal', name: 'e2e-page-history-go' },
      steps: [{ kind: 'await-signal', signal: 'e2e-page-history-wait' }],
    });
    const started = await bureau(request, 'bureau.workflows.signal', {
      name: 'e2e-page-history-go',
    });
    expect((started.result as { started: string[] }).started).toHaveLength(1);
    const read = await bureau(request, 'bureau.workflows.get', { id });
    await bureau(request, 'bureau.workflows.update', {
      id,
      expectedHash: (read.result as { hash: string }).hash,
      definition: {
        agent: 'assistant',
        trigger: { kind: 'signal', name: 'e2e-page-history-go' },
        steps: [{ kind: 'await-signal', signal: 'e2e-page-history-wait-later' }],
      },
    });

    await page.goto(`/workflows/${id}?tab=history`);
    const version = detail(page).getByTestId('workflow-revisions').locator('[data-version]');
    await expect(version).toHaveCount(1);
    await expect(version.getByTestId('workflow-revision-verdict')).toContainText(
      WORKFLOW_COPY.revisions.incompatible,
    );
    await expect(version.getByTestId('workflow-revision-reasons')).toContainText(
      WORKFLOW_COPY.revisions.reason('artifact-revision-mismatch'),
    );

    await expect
      .poll(async () => {
        await bureau(request, 'bureau.workflows.signal', { name: 'e2e-page-history-wait' });
        const runs = await listWorkflowRuns(request, id);
        return runs[0]?.status;
      })
      .toBe('completed');
  });
});
