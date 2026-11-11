/**
 * `/workflows/:workflow` by its tabs, against the real host: Overview (steps as rows, input and
 * output as field lists), Code (a file's source, or what a code-defined type registered), Runs, and
 * History. The tab is in the address, and Start run in the header opens the run setup page. Each
 * tab meets axe at the two widths the application is built for.
 *
 * The host serves the engine's console from the fixtures' engine, which is not the Bureau's, so a
 * code-defined type of the fixtures' engine is not one the Bureau registered: its Code tab says
 * there is no source. The Bureau's own host (`E2E_BUREAU_URL`) registers `agentRun`, a type it runs
 * itself, which has only Overview and Runs: there is no Code tab until Weft exposes its source.
 */
import type { Page } from '@playwright/test';
import { rm, writeFile } from 'node:fs/promises';

import { WORKFLOW_COPY } from '../../src/app/copy.ts';
import { bureau } from './agent-support.ts';
import { E2E_BUREAU_URL } from './e2e-constants.ts';
import { expect, loggedFailedResponse, test } from './fixtures.ts';
import { expectEngineMissesForFileRuns } from './task-support.ts';
import {
  createWorkflowFile,
  expectTabNames,
  expectTabOpen,
  listWorkflowRuns,
  openTab,
  removeWorkflow,
  SEEDED_WORKFLOWS,
  workflowFilePath,
  workflowRunStatus,
} from './workflow-support.ts';

const WIDTHS = [375, 1280] as const;
const TABS = WORKFLOW_COPY.page.tabs;

const area = (page: Page) => page.locator('[data-view="workflows"]');
const detail = (page: Page) => page.locator('[data-page="workflow-detail"]');

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

      await expectTabNames(root, [
        new RegExp(`^${TABS.overview}$`),
        new RegExp(`^${TABS.code}$`),
        new RegExp(`^${TABS.runs}( \\d+)?$`),
        new RegExp(`^${TABS.history}( \\d+)?$`),
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
      await openTab(detail(page), TABS.code);
      const root = detail(page);

      const file = await bureau(request, 'bureau.workflows.get', { id: SEEDED_WORKFLOWS.digest });
      const text = (file.result as { text: string }).text;
      await expect(root.getByTestId('workflow-file-source')).toContainText(
        text.split('\n')[1]?.trim() ?? '"name"',
      );
      // The outline is beside the file where there is room, and a select above it on a phone.
      if (width < 640) {
        await expect(
          root.getByRole('combobox', { name: WORKFLOW_COPY.page.code.outlineSelect }),
        ).toBeVisible();
        await expect(root.getByTestId('workflow-outline')).toHaveCount(0);
      } else {
        await expect(root.getByTestId('workflow-outline').getByRole('link').first()).toBeVisible();
      }
      await expect(root.getByTestId('workflow-code')).toContainText(
        WORKFLOW_COPY.page.code.caption.after.trim(),
      );
      await checkA11y(`the Code tab of a file at ${width}px`);
    });
  }

  test('has no Code tab for a type the Bureau registers for itself, so its address falls back to the Overview, on the Bureau’s host', async ({
    browser,
  }) => {
    const context = await browser.newContext({ baseURL: E2E_BUREAU_URL });
    const page = await context.newPage();
    try {
      await page.goto('/workflows/agentRun?tab=code');
      await expect(area(page)).toHaveAttribute('data-state', 'ready');
      const root = detail(page);
      // Only Overview and Runs: there is no source to show until Weft exposes it.
      await expectTabNames(root, [
        new RegExp(`^${TABS.overview}$`),
        new RegExp(`^${TABS.runs}( \\d+)?$`),
      ]);
      await expectTabOpen(root, TABS.overview);
      await expect(page).not.toHaveURL(/tab=/);
      await expect(root.getByTestId('workflow-code')).toHaveCount(0);
      await expect(
        root.getByRole('link', { name: WORKFLOW_COPY.page.seeInternal }),
      ).toHaveAttribute('href', '/internal-workflows');
      await expect(root.getByRole('heading', { level: 1 })).toHaveText(
        WORKFLOW_COPY.internal.types.agentRun.title,
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
    await openTab(detail(page), TABS.runs);
    await expect(page).toHaveURL(/\?tab=runs$/);
    await page.reload();
    await expectTabOpen(detail(page), TABS.runs);
    await openTab(detail(page), TABS.overview);
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
  test('opens the run setup page, which starts a real instance with the input', async ({
    page,
    request,
    pageErrors,
  }) => {
    const id = 'e2e-page-start';
    created.add(id);
    await createWorkflowFile(request, id, {
      trigger: { kind: 'signal', name: 'e2e-page-start-go' },
      steps: [{ kind: 'await-signal', signal: 'e2e-page-start-wait' }],
    });
    await page.goto(`/workflows/${id}`);
    await expect(area(page)).toHaveAttribute('data-state', 'ready');
    await detail(page).getByRole('link', { name: WORKFLOW_COPY.page.startAction }).click();
    await expect(page).toHaveURL(new RegExp(`/workflows/${id}/run$`));
    // A file that declares no schema takes its input as JSON.
    await page
      .getByRole('textbox', { name: WORKFLOW_COPY.runSetup.jsonLabel })
      .fill('{ "topic": "weather" }');
    expectEngineMissesForFileRuns(pageErrors);
    await page.getByRole('button', { name: WORKFLOW_COPY.runSetup.startAction }).click();

    await expect(page).toHaveURL(new RegExp(`/workflows/${id}/runs/[^/]+$`));
    const [run] = await listWorkflowRuns(request, id);
    expect(run?.status).toBe('running');
    // The instance took the input the page held, as JSON, and was started from the web surface.
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

    // The Bureau's record of the instance fills the page: the workflow leads it, and links to its page.
    await expect(page.getByRole('heading', { level: 1, name: id })).toBeVisible();
    await expect(
      page.getByRole('complementary', { name: 'Details' }).getByRole('link', { name: id }),
    ).toHaveAttribute('href', `/workflows/${id}`);
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
      detail(page).getByRole('link', { name: WORKFLOW_COPY.page.startAction }),
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
        agent: 'demo:assistant',
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

test.describe('the header', () => {
  test('says what starts the workflow, the agent it runs as, and its file on the lines under the title', async ({
    page,
    request,
  }) => {
    const id = 'e2e-page-header';
    created.add(id);
    await createWorkflowFile(request, id, {
      description: 'Says hello.',
      trigger: { kind: 'signal', name: 'e2e-page-header-go' },
      steps: [{ kind: 'await-signal', signal: 'e2e-page-header-wait' }],
    });
    await page.goto(`/workflows/${id}`);
    await expect(area(page)).toHaveAttribute('data-state', 'ready');
    const root = detail(page);

    await expect(root.getByTestId('workflow-description')).toHaveText('Says hello.');
    const starts = root.getByTestId('workflow-line-starts');
    await expect(starts).toContainText(WORKFLOW_COPY.page.header.startsOnSignal.before);
    await expect(starts.locator('code')).toHaveText('e2e-page-header-go');
    await expect(starts).toContainText(WORKFLOW_COPY.page.header.startYourself);
    // Nothing has run it, and the file is named once, on the second line.
    const last = root.getByTestId('workflow-line-last-run');
    await expect(last).toContainText(WORKFLOW_COPY.page.header.neverRun);
    await expect(last.locator('code')).toHaveText(`${id}.json`);
    // The Runs tab carries its count after the label once it is known.
    await expect(root.getByRole('tab', { name: /^Runs( 0)?$/ })).toBeVisible();
  });
});

test.describe('a file that cannot load', () => {
  test('is a banner that names the line, a marked line on the Code tab, and a way into the JSON editor', async ({
    page,
    request,
    checkA11y,
  }) => {
    const id = 'e2e-page-comma';
    created.add(id);
    await createWorkflowFile(request, id);
    // A comma is left out at the end of line 2, so the parser stops at line 3.
    await writeFile(
      await workflowFilePath(request, id),
      ['{', `  "name": "${id}"`, '  "steps": []', '}'].join('\n'),
    );
    await expect
      .poll(async () => {
        const read = await bureau(request, 'bureau.workflows.get', { id });
        return (read.result as { state?: string } | undefined)?.state;
      })
      .toBe('invalid');

    await page.goto(`/workflows/${id}`);
    await expect(area(page)).toHaveAttribute('data-state', 'ready');
    const root = detail(page);
    await expect(root.getByRole('heading', { level: 1 })).toHaveText(id);
    await expect(root.getByTestId('workflow-state')).toContainText("Can't load");
    await expect(root.getByTestId('workflow-problem')).toContainText(
      WORKFLOW_COPY.page.problem.located(`${id}.json`, 3, WORKFLOW_COPY.page.problem.expectedComma),
    );
    await expect(
      root.getByRole('button', { name: WORKFLOW_COPY.page.startAction }),
    ).toHaveAttribute('aria-disabled', 'true');
    await checkA11y('the Overview of a file that cannot load');

    await root.getByRole('button', { name: WORKFLOW_COPY.page.problem.openCode }).click();
    await expect(root.getByRole('note')).toContainText(WORKFLOW_COPY.page.problem.missingComma(3));
    await expect(
      root.getByRole('button', { name: WORKFLOW_COPY.page.problem.editAsJson }),
    ).toBeVisible();
    await checkA11y('the Code tab of a file that cannot load');

    await root.getByRole('button', { name: WORKFLOW_COPY.page.problem.editAsJson }).click();
    await expect(page).toHaveURL(new RegExp(`/workflows/${id}/edit\\?tab=json$`));
  });
});

test.describe('the signal dialog', () => {
  test('is opened from the "⋯" menu, and the Overview holds no signal form', async ({
    page,
    request,
  }) => {
    const id = 'e2e-page-signal';
    created.add(id);
    await createWorkflowFile(request, id, {
      trigger: { kind: 'signal', name: 'e2e-page-signal-go' },
      steps: [{ kind: 'await-signal', signal: 'e2e-page-signal-wait' }],
    });
    await page.goto(`/workflows/${id}`);
    await expect(area(page)).toHaveAttribute('data-state', 'ready');
    await expect(detail(page).getByTestId('workflow-signal')).toHaveCount(0);

    await detail(page).getByRole('button', { name: WORKFLOW_COPY.page.menu.label }).click();
    await page.getByRole('menuitem', { name: WORKFLOW_COPY.page.menu.sendSignal }).click();
    const dialog = page.getByRole('dialog', { name: WORKFLOW_COPY.signal.heading });
    await expect(dialog.getByRole('textbox', { name: WORKFLOW_COPY.signal.nameLabel })).toHaveValue(
      'e2e-page-signal-go',
    );
    await dialog.getByRole('button', { name: WORKFLOW_COPY.page.menu.closeSignal }).click();
    await expect(dialog).toHaveCount(0);
  });
});
