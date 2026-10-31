/**
 * The Workflows area against the real host: `/workflows` lists the engine's definitions with the
 * Bureau's workflow files, `/workflows/new` makes one, `/workflows/:workflow` shows one and acts on its
 * file, `/workflows/:workflow/runs` lists its runs, and `/workflows/:workflow/edit` edits its JSON. A workflow is a JSON file in the
 * host's temporary home, so the specs create, change, and delete real files; three are seeded by
 * `e2e-server.ts`. Every page meets axe at the two widths the application is built for.
 *
 * The host serves the engine's console from the fixtures' engine, which is not the Bureau's, so a
 * Bureau file has no engine definition, schedule, or run here. The pages say so and carry on; the
 * join, and a file's run, are read through the Bureau's own operations. A code-defined type
 * (`inventory-sync-sweep`) is the engine's, with its schedules and its runs.
 */
import type { Page } from '@playwright/test';
import { readFile, rm, writeFile } from 'node:fs/promises';

import { VIEW_COPY, WORKFLOW_COPY } from '../../src/app/copy.ts';
import { describeCadence } from '../../src/routes/schedules/cadence.ts';
import { bureau } from './agent-support.ts';
import { E2E_BUREAU_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';
import { jsonEditor, jsonEditorSource } from './json-editor-support.ts';
import {
  APPROVAL_SIGNAL,
  APPROVAL_START_SIGNAL,
  createWorkflowFile,
  listWorkflowRuns,
  readWorkflow,
  removeWorkflow,
  SEEDED_WORKFLOWS,
  workflowDirectory,
  workflowFaultCode,
  workflowFilePath,
  workflowRunStatus,
} from './workflow-support.ts';

const WIDTHS = [375, 1280] as const;

/** A document needs at least one step. */
const STEPS = [
  { kind: 'activity', handler: 'agent', input: { agent: 'demo:assistant', message: 'Say hello.' } },
];

/** Identifiers this file's specs create, removed after each spec. */
const created = new Set<string>();

test.afterEach(async ({ request }) => {
  for (const id of created) {
    await removeWorkflow(request, id);
    await rm(await workflowFilePath(request, id), { force: true });
  }
  created.clear();
});

async function makeWorkflow(
  request: Parameters<typeof createWorkflowFile>[0],
  id: string,
  definition: Record<string, unknown> = {},
) {
  created.add(id);
  return createWorkflowFile(request, id, definition);
}

const area = (page: Page) => page.locator('[data-view="workflows"]');
const detail = (page: Page) => page.locator('[data-page="workflow-detail"]');
const row = (page: Page, name: string) => page.locator(`[data-workflow="${name}"]`);

/** The types the Bureau registers for itself: the host whose console is the Bureau's engine holds them, and the fixtures' engine does not. */
const ENGINE_TYPES = ['agentRun', 'durableHeartbeatTick', 'goalRun'] as const;

test.describe('the list', () => {
  for (const width of WIDTHS) {
    test(`has a row for a code-defined type, a file with an agent, and an invalid file, at ${width} pixels`, async ({
      page,
      request,
      checkA11y,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/workflows');
      await expect(area(page)).toHaveAttribute('data-state', 'ready');
      await expect(page.getByRole('heading', { level: 1, name: 'Workflows' })).toBeVisible();
      await expect(page.getByRole('link', { name: WORKFLOW_COPY.newAction })).toHaveAttribute(
        'href',
        '/workflows/new',
      );

      // A code-defined type: its name, the code badge, and what the engine says of it.
      const code = row(page, 'inventory-sync-sweep');
      await expect(code).toHaveAttribute('data-kind', 'code');
      await expect(code.getByRole('link', { name: 'inventory-sync-sweep' })).toBeVisible();
      await expect(code).toContainText(WORKFLOW_COPY.codeBadge);
      await expect(code).not.toContainText(WORKFLOW_COPY.agentAuthoredBadge);
      await expect(code.getByTestId('workflow-run-counts')).toHaveText(
        /^(\d+ runs? in 24 hours( \(\d+ running\))?|No runs yet)$/,
      );

      // A file that loads: its description, the agent-authored badge, the agent that owns it
      // (monospace, since it is an identifier), its cadence in words, and its counts.
      const digest = row(page, SEEDED_WORKFLOWS.digest);
      await expect(digest).toHaveAttribute('data-kind', 'agent-authored');
      await expect(digest).toContainText(WORKFLOW_COPY.agentAuthoredBadge);
      await expect(digest.getByTestId('workflow-description')).toHaveText(
        'Writes the daily digest.',
      );
      await expect(digest.getByTestId('workflow-agent')).toHaveText('assistant');
      await expect(digest.getByTestId('workflow-agent')).toHaveCSS(
        'font-family',
        /mono|Menlo|Consolas|Courier/i,
      );
      await expect(digest.getByTestId('workflow-cadence')).toHaveText(
        describeCadence({ intervalMs: 86_400_000 }),
      );
      await expect(digest.getByTestId('workflow-run-counts')).toHaveText(
        WORKFLOW_COPY.list.neverRun,
      );
      await expect(digest.getByTestId('workflow-problem')).toHaveCount(0);

      // A file started by a signal names the signal.
      await expect(
        row(page, SEEDED_WORKFLOWS.approval).getByTestId('workflow-cadence'),
      ).toContainText(APPROVAL_START_SIGNAL);

      // A file the Bureau cannot use: its error, its issues, and its path.
      const broken = row(page, SEEDED_WORKFLOWS.broken);
      await expect(broken).toHaveAttribute('data-state', 'invalid');
      await expect(broken).toContainText(WORKFLOW_COPY.agentAuthoredBadge);
      // A file the Bureau cannot use has failed: its status is the word Failed, not a badge of its own.
      await expect(broken).toHaveAttribute('data-status', 'Failed');
      await expect(broken.getByTestId('workflow-problem')).toContainText('invalid-document');
      await expect(broken.getByTestId('workflow-issues')).toContainText('steps');
      await expect(broken.getByTestId('workflow-file-path')).toHaveText(
        await workflowFilePath(request, SEEDED_WORKFLOWS.broken),
      );
      await expect(broken.getByTestId('workflow-run-counts')).toHaveCount(0);

      // A source with no file is the engine's alone, so it is left out: the list reads the same
      // before and after a restart.
      await expect(row(page, 'invoice-reconciliation')).toHaveCount(0);
      await checkA11y(`the list at ${width}px`);
    });
  }

  test('links a name to its page', async ({ page }) => {
    await page.goto('/workflows');
    await row(page, 'inventory-sync-sweep')
      .getByRole('link', { name: 'inventory-sync-sweep' })
      .click();
    await expect(page).toHaveURL(/\/workflows\/inventory-sync-sweep$/);
    await expect(detail(page)).toBeVisible();
  });

  test('lists a file as soon as it exists, and not after it is deleted', async ({
    page,
    request,
  }) => {
    await makeWorkflow(request, 'e2e-listed');
    await page.goto('/workflows');
    await expect(row(page, 'e2e-listed')).toHaveAttribute('data-kind', 'agent-authored');
    await removeWorkflow(request, 'e2e-listed');
    await page.reload();
    await expect(row(page, 'e2e-listed')).toHaveCount(0);
  });

  test('counts a file’s instances: running, and begun in the last day', async ({
    page,
    request,
  }) => {
    await makeWorkflow(request, 'e2e-counted', {
      trigger: { kind: 'signal', name: 'e2e-counted-go' },
      steps: [{ kind: 'await-signal', signal: 'e2e-counted-wait' }],
    });
    await bureau(request, 'bureau.workflows.signal', { name: 'e2e-counted-go' });
    try {
      await page.goto('/workflows');
      const counts = row(page, 'e2e-counted').getByTestId('workflow-run-counts');
      await expect(counts).toHaveText('1 run in 24 hours (1 running)');
      await expect(row(page, 'e2e-counted').getByTestId('workflow-last-run')).toContainText(
        'last run',
      );
    } finally {
      // Let the instance finish, so it does not stay in the host.
      await expect
        .poll(async () => {
          await bureau(request, 'bureau.workflows.signal', { name: 'e2e-counted-wait' });
          const runs = await listWorkflowRuns(request, 'e2e-counted');
          return runs[0]?.status;
        })
        .toBe('completed');
    }
  });

  test.describe('on the host whose console is the Bureau’s own engine', () => {
    test.use({ baseURL: E2E_BUREAU_URL });

    for (const width of WIDTHS) {
      test(`links the types the Bureau registers for itself to a page of their own, at ${width} pixels`, async ({
        page,
        checkA11y,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto('/workflows');
        await expect(area(page)).toHaveAttribute('data-state', 'ready');
        await expect(row(page, SEEDED_WORKFLOWS.digest)).toBeVisible();

        const link = area(page).getByRole('link', {
          name: WORKFLOW_COPY.list.internalWorkflows(ENGINE_TYPES.length),
        });
        await expect(link).toHaveAttribute('href', '/internal-workflows');
        for (const name of ENGINE_TYPES) await expect(row(page, name)).toHaveCount(0);
        await checkA11y(`the list without the Bureau’s own types at ${width}px`);

        await link.click();
        await expect(page).toHaveURL(/\/internal-workflows$/);
        await expect(
          page.getByRole('heading', { level: 1, name: WORKFLOW_COPY.internal.title }),
        ).toBeVisible();
        for (const name of ENGINE_TYPES) {
          await expect(row(page, name)).toBeVisible();
          // Each says in a line what it does.
          await expect(row(page, name).getByTestId('workflow-description')).not.toHaveText('');
        }
        await expect(
          row(page, 'agentRun').getByRole('link', { name: 'Agent Run' }),
        ).toHaveAttribute('href', '/workflows/agentRun');
        await expect(row(page, 'agentRun').getByTestId('workflow-identifier')).toHaveText(
          'agentRun',
        );
        await checkA11y(`the Bureau’s own types at ${width}px`);
      });
    }

    for (const width of WIDTHS) {
      test(`on a host with no workflow of its own, says there are none yet, offers New workflow, and links the Bureau’s types, at ${width} pixels`, async ({
        page,
        request,
        checkA11y,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        // A fresh host: the Bureau has no file. The engine holds only the types the Bureau registers.
        await page.route(/\/bureau\/jsonrpc/, async (route) => {
          const body = route.request().postData() ?? '';
          if (!body.includes('"bureau.workflows.list"')) {
            await route.fallback();
            return;
          }
          const id = (JSON.parse(body) as { id?: unknown }).id ?? null;
          await route.fulfill({
            json: { jsonrpc: '2.0', id, result: { workflows: [], nextOffset: null } },
          });
        });
        await page.goto('/workflows');
        await expect(area(page)).toHaveAttribute('data-state', 'ready');
        const empty = area(page).getByTestId('workflows-empty');
        await expect(empty).toContainText(WORKFLOW_COPY.list.emptyTitle);
        await expect(empty).toContainText(WORKFLOW_COPY.list.emptyTool);
        await expect(empty.getByTestId('workflow-directory')).toHaveText(
          await workflowDirectory(request),
        );
        await expect(page.getByRole('link', { name: WORKFLOW_COPY.newAction })).toBeVisible();
        await expect(
          area(page).getByRole('link', {
            name: WORKFLOW_COPY.list.internalWorkflows(ENGINE_TYPES.length),
          }),
        ).toBeVisible();
        for (const name of ENGINE_TYPES) await expect(row(page, name)).toHaveCount(0);
        await checkA11y(`the list of a host with no workflow at ${width}px`);
      });
    }
  });
});

test.describe('a new workflow', () => {
  for (const width of WIDTHS) {
    test(`is written from the template, saved as a file the Bureau lists as ready, and opened, at ${width} pixels`, async ({
      page,
      request,
      checkA11y,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      created.add('e2e-brand-new');
      await page.goto('/workflows');
      await page.getByRole('link', { name: WORKFLOW_COPY.newAction }).click();
      await expect(page).toHaveURL(/\/workflows\/new$/);
      await expect(area(page)).toHaveAttribute('data-state', 'ready');
      const root = page.locator('[data-page="workflow-creator"]');
      await expect(
        root.getByRole('heading', { level: 1, name: WORKFLOW_COPY.creator.heading }),
      ).toBeVisible();

      const editor = await jsonEditor(root, WORKFLOW_COPY.creator.textLabel);
      const template = JSON.parse(await jsonEditorSource(editor)) as Record<string, unknown>;
      expect(template).toMatchObject({
        name: WORKFLOW_COPY.creator.templateName,
        trigger: { kind: 'schedule' },
        steps: [{ kind: 'activity', handler: 'agent' }],
      });
      await checkA11y(`the new-workflow editor at ${width}px`);

      template['name'] = 'e2e-brand-new';
      template['description'] = 'Made from the template.';
      await editor.fill(JSON.stringify(template, null, 2));
      await root.getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }).click();

      await expect(page).toHaveURL(/\/workflows\/e2e-brand-new$/);
      await expect(detail(page).getByRole('heading', { level: 1 })).toHaveText('e2e-brand-new');
      await expect(detail(page).getByTestId('workflow-description')).toHaveText(
        'Made from the template.',
      );
      const made = await readWorkflow(request, 'e2e-brand-new');
      expect(made.state).toBe('ready');
      const listed = await bureau(request, 'bureau.workflows.list', {});
      const entry = (
        listed.result as { workflows: Array<{ id: string; state: string }> }
      ).workflows.find((workflow) => workflow.id === 'e2e-brand-new');
      expect(entry?.state).toBe('ready');
      await page.goto('/workflows');
      await expect(row(page, 'e2e-brand-new')).toHaveAttribute('data-kind', 'agent-authored');
    });
  }

  test('refuses a name that is taken, and one that is not an identifier, and writes nothing', async ({
    page,
  }) => {
    await page.goto('/workflows/new');
    const root = page.locator('[data-page="workflow-creator"]');
    const editor = await jsonEditor(root, WORKFLOW_COPY.creator.textLabel);
    const template = JSON.parse(await jsonEditorSource(editor)) as Record<string, unknown>;

    template['name'] = SEEDED_WORKFLOWS.digest;
    await editor.fill(JSON.stringify(template));
    await root.getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }).click();
    await expect(root).toContainText(WORKFLOW_COPY.creator.taken(SEEDED_WORKFLOWS.digest));

    template['name'] = 'Not An Identifier';
    await editor.fill(JSON.stringify(template));
    await root.getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }).click();
    await expect(root).toContainText(WORKFLOW_COPY.creator.invalidName);

    template['name'] = 'new';
    await editor.fill(JSON.stringify(template));
    await root.getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }).click();
    await expect(root).toContainText(WORKFLOW_COPY.creator.reservedName);
    await expect(page).toHaveURL(/\/workflows\/new$/);
  });

  test('cancel goes back to the list', async ({ page }) => {
    await page.goto('/workflows/new');
    await page
      .locator('[data-page="workflow-creator"]')
      .getByRole('button', { name: WORKFLOW_COPY.creator.cancelAction })
      .click();
    await expect(page).toHaveURL(/\/workflows$/);
  });
});

test.describe('a code-defined type', () => {
  for (const width of WIDTHS) {
    test(`leads with what starts it, shows no row for what it lacks, and keeps its runs and the engine’s revisions on tabs, at ${width} pixels`, async ({
      page,
      checkA11y,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/workflows/inventory-sync-sweep');
      await expect(area(page)).toHaveAttribute('data-state', 'ready');
      await expect(
        detail(page).getByRole('heading', { level: 1, name: 'inventory-sync-sweep' }),
      ).toBeVisible();
      await expect(detail(page)).toContainText(WORKFLOW_COPY.codeBadge);
      await expect(detail(page)).not.toContainText(WORKFLOW_COPY.agentAuthoredBadge);

      // The active and the paused schedule, each once, with what starts it said in words.
      const schedules = detail(page).locator('[data-schedule]');
      await expect(schedules).toHaveCount(2);
      await expect(
        detail(page).locator('[data-schedule="inventory-sync-every-5-minutes"]'),
      ).toHaveAttribute('data-status', 'active');
      await expect(
        detail(page).locator('[data-schedule="nightly-inventory-audit"]'),
      ).toHaveAttribute('data-status', 'paused');
      await expect(detail(page).getByTestId('workflow-trigger')).toHaveText(
        WORKFLOW_COPY.list.schedules(2),
      );

      // Nothing the type lacks is a row, and no form to install a revision is on the page.
      await expect(detail(page)).not.toContainText(/\bNone\b/);
      await expect(detail(page)).not.toContainText('Install a revision');
      await expect(detail(page).locator('.weft-revisions-panel')).toHaveCount(0);
      await expect(page.getByRole('button', { name: WORKFLOW_COPY.deleteAction })).toHaveCount(0);
      await expect(page.getByRole('link', { name: WORKFLOW_COPY.editAction })).toHaveCount(0);

      // The engine's contract for this type declares no signal, update or query, so there are no facts to list.
      await expect(detail(page).getByTestId('workflow-definition')).toHaveCount(0);

      // Runs holds its newest runs.
      await detail(page).getByRole('tab', { name: WORKFLOW_COPY.page.tabs.runs }).click();
      await expect(detail(page).getByTestId('workflow-recent-runs')).toBeVisible();

      // History holds the revisions, and the install form with them.
      await detail(page).getByRole('tab', { name: WORKFLOW_COPY.page.tabs.history }).click();
      await expect(detail(page).locator('.weft-revisions-panel')).toBeVisible();
      await checkA11y(`a code-defined type at ${width}px`);
    });
  }

  test.describe('on the host whose console is the Bureau’s own engine', () => {
    test.use({ baseURL: E2E_BUREAU_URL });

    test('a type the Bureau registers for itself has no History tab and no install form', async ({
      page,
    }) => {
      await page.goto('/workflows/agentRun');
      await expect(area(page)).toHaveAttribute('data-state', 'ready');
      await expect(detail(page).getByRole('heading', { level: 1, name: 'agentRun' })).toBeVisible();
      await expect(
        detail(page).getByRole('tab', { name: WORKFLOW_COPY.page.tabs.history }),
      ).toHaveCount(0);
      await expect(detail(page)).not.toContainText('Install a revision');
      await expect(detail(page)).not.toContainText(/\bNone\b/);
    });
  });
});

test.describe('an agent-authored type', () => {
  for (const width of WIDTHS) {
    test(`leads with its agent, description, cadence and state, and its steps, and keeps its runs and the versions on tabs, at ${width} pixels`, async ({
      page,
      request,
      checkA11y,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/workflows/${SEEDED_WORKFLOWS.digest}`);
      await expect(area(page)).toHaveAttribute('data-state', 'ready');
      const root = detail(page);
      await expect(root.getByRole('heading', { level: 1 })).toHaveText(SEEDED_WORKFLOWS.digest);
      await expect(root).toContainText(WORKFLOW_COPY.agentAuthoredBadge);
      await expect(root.getByTestId('workflow-agent')).toHaveText('demo:assistant');
      await expect(root.getByTestId('workflow-description')).toHaveText('Writes the daily digest.');
      await expect(root.getByTestId('workflow-trigger')).toHaveText(
        describeCadence({ intervalMs: 86_400_000 }),
      );
      await expect(root.getByTestId('workflow-state')).toHaveText(WORKFLOW_COPY.page.statusActive);
      await expect(root.getByTestId('workflow-steps').getByRole('listitem')).toHaveCount(2);
      await expect(root.getByRole('button', { name: WORKFLOW_COPY.pauseAction })).toBeVisible();
      await expect(root.getByRole('link', { name: WORKFLOW_COPY.editAction })).toHaveAttribute(
        'href',
        `/workflows/${SEEDED_WORKFLOWS.digest}/edit`,
      );
      await expect(root).not.toContainText(/\bNone\b/);

      // The Overview says where the file is, and the trigger as written.
      await expect(root.getByTestId('workflow-file-path')).toHaveText(
        await workflowFilePath(request, SEEDED_WORKFLOWS.digest),
      );
      await expect(root.getByTestId('workflow-trigger-source')).toContainText('24h');

      // Nothing has run it, and the Runs tab says so with an action that starts one.
      await root.getByRole('tab', { name: WORKFLOW_COPY.page.tabs.runs }).click();
      await expect(root.getByTestId('workflow-recent-runs')).toContainText(
        WORKFLOW_COPY.page.runs.emptyTitle,
      );

      // History holds the versions that ran: none has, and the page does not offer to activate one.
      await expect(root.getByTestId('workflow-revisions')).toHaveCount(0);
      await root.getByRole('tab', { name: WORKFLOW_COPY.page.tabs.history }).click();
      await expect(root.getByTestId('workflow-revisions')).toContainText(
        WORKFLOW_COPY.revisions.emptyTitle,
      );
      await expect(root.getByRole('button', { name: /Activate/ })).toHaveCount(0);
      await checkA11y(`an agent-authored type at ${width}px`);
    });
  }

  test('lists the versions that ran, and only those', async ({ page, request }) => {
    await makeWorkflow(request, 'e2e-ran', {
      trigger: { kind: 'signal', name: 'e2e-ran-go' },
      steps: [{ kind: 'await-signal', signal: 'e2e-ran-wait' }],
    });
    const started = await bureau(request, 'bureau.workflows.signal', { name: 'e2e-ran-go' });
    expect((started.result as { started: string[] }).started).toHaveLength(1);
    const file = await readWorkflow(request, 'e2e-ran');
    // A second version is saved and never runs.
    await bureau(request, 'bureau.workflows.update', {
      id: 'e2e-ran',
      expectedHash: file.hash,
      definition: {
        agent: 'demo:assistant',
        trigger: { kind: 'signal', name: 'e2e-ran-go' },
        steps: [{ kind: 'await-signal', signal: 'e2e-ran-wait-later' }],
      },
    });
    await page.goto('/workflows/e2e-ran');
    await detail(page).getByRole('tab', { name: WORKFLOW_COPY.page.tabs.history }).click();
    const versions = detail(page).getByTestId('workflow-revisions').locator('[data-version]');
    await expect(versions).toHaveCount(1);
    // The file was edited after that version ran, so Weft's verdict against the current one is no.
    await expect(versions.first().getByTestId('workflow-revision-verdict')).toContainText(
      WORKFLOW_COPY.revisions.incompatible,
    );
    await expect(versions.first().getByTestId('workflow-revision-reasons')).toContainText(
      WORKFLOW_COPY.revisions.reason('workflow-version-incompatible'),
    );
    // Let the instance finish, so it does not stay in the host.
    await expect
      .poll(async () => {
        await bureau(request, 'bureau.workflows.signal', { name: 'e2e-ran-wait' });
        const runs = await listWorkflowRuns(request, 'e2e-ran');
        return runs[0]?.status;
      })
      .toBe('completed');
  });
});

test.describe('an invalid file', () => {
  for (const width of WIDTHS) {
    test(`shows its problem, its path, and delete and edit, with no definition, at ${width} pixels`, async ({
      page,
      request,
      checkA11y,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/workflows/${SEEDED_WORKFLOWS.broken}`);
      await expect(area(page)).toHaveAttribute('data-state', 'ready');
      const root = detail(page);
      await expect(root.getByTestId('workflow-problem')).toContainText('invalid-document');
      await expect(root.getByTestId('workflow-issues')).toContainText('steps');
      await expect(root.getByTestId('workflow-file-path')).toHaveText(
        await workflowFilePath(request, SEEDED_WORKFLOWS.broken),
      );
      await expect(root.getByTestId('workflow-definition')).toHaveCount(0);
      await expect(root.getByRole('button', { name: WORKFLOW_COPY.deleteAction })).toBeVisible();
      await expect(root.getByRole('link', { name: WORKFLOW_COPY.editAction })).toBeVisible();
      await expect(root.getByRole('button', { name: WORKFLOW_COPY.pauseAction })).toHaveCount(0);
      await expect(root.getByTestId('workflow-signal')).toHaveCount(0);
      await checkA11y(`an invalid file at ${width}px`);
    });
  }

  test('is not found once the file is deleted, with the engine knowing nothing of it either', async ({
    page,
    request,
  }) => {
    const directory = await workflowDirectory(request);
    expect(directory).toBeTruthy();
    await makeWorkflow(request, 'e2e-gone');
    await removeWorkflow(request, 'e2e-gone');
    await page.goto('/workflows/e2e-gone');
    await expect(area(page)).toHaveAttribute('data-state', 'not-found');
    await expect(area(page).getByRole('heading', { level: 1 })).toHaveText(
      VIEW_COPY.workflows.notFoundByPattern?.['/workflows/:workflow']?.title ??
        VIEW_COPY.workflows.notFound?.title ??
        '',
    );
  });
});

test.describe('pause, resume, and delete', () => {
  for (const width of WIDTHS) {
    test(`show the new state without a reload, at ${width} pixels`, async ({
      page,
      request,
      checkA11y,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await makeWorkflow(request, 'e2e-pausable');
      await page.goto('/workflows/e2e-pausable');
      const root = detail(page);
      await expect(root).toHaveAttribute('data-condition', 'ready');
      await expect(root.getByTestId('workflow-state')).toHaveText(WORKFLOW_COPY.page.statusActive);

      await root.getByRole('button', { name: WORKFLOW_COPY.pauseAction }).click();
      await expect(root.getByRole('button', { name: WORKFLOW_COPY.resumeAction })).toBeVisible();
      await expect(root.getByTestId('workflow-state')).toHaveText(WORKFLOW_COPY.page.statusPaused);
      const paused = await readWorkflow(request, 'e2e-pausable');
      expect(paused.paused).toBe(true);
      await checkA11y(`a paused workflow at ${width}px`);

      await root.getByRole('button', { name: WORKFLOW_COPY.resumeAction }).click();
      await expect(root.getByRole('button', { name: WORKFLOW_COPY.pauseAction })).toBeVisible();
      await expect(root.getByTestId('workflow-state')).toHaveText(WORKFLOW_COPY.page.statusActive);
      const resumed = await readWorkflow(request, 'e2e-pausable');
      expect(resumed.paused).toBe(false);

      // Delete confirms, removes the file, and goes to the list, where the row is gone.
      await root.getByRole('button', { name: WORKFLOW_COPY.deleteAction }).click();
      const dialog = page.getByRole('dialog', { name: WORKFLOW_COPY.deleteDialog.title });
      await checkA11y(`the delete confirmation at ${width}px`);
      await dialog.getByRole('button', { name: WORKFLOW_COPY.deleteDialog.confirm }).click();
      await expect(page).toHaveURL(/\/workflows$/);
      await expect(row(page, 'e2e-pausable')).toHaveCount(0);
      expect(await workflowFaultCode(request, 'e2e-pausable')).toBe('NotFound');
    });
  }

  test('a file changed on disk after the page loaded shows the changed-outside state, and changes nothing', async ({
    page,
    request,
    checkA11y,
  }) => {
    await makeWorkflow(request, 'e2e-stale');
    await page.goto('/workflows/e2e-stale');
    const root = detail(page);
    await expect(root.getByRole('button', { name: WORKFLOW_COPY.pauseAction })).toBeVisible();

    // Someone edits the file after the page loaded.
    const before = await readWorkflow(request, 'e2e-stale');
    await bureau(request, 'bureau.workflows.update', {
      id: 'e2e-stale',
      expectedHash: before.hash,
      definition: {
        agent: 'demo:assistant',
        trigger: { kind: 'schedule', spec: '12h' },
        steps: [
          {
            kind: 'activity',
            handler: 'agent',
            input: { agent: 'demo:assistant', message: 'Edited.' },
          },
        ],
      },
    });
    const edited = await readWorkflow(request, 'e2e-stale');

    await root.getByRole('button', { name: WORKFLOW_COPY.pauseAction }).click();
    await expect(root).toHaveAttribute('data-condition', 'stale');
    await expect(root).toContainText(WORKFLOW_COPY.stale.title);
    await checkA11y('the changed-outside state');
    const after = await readWorkflow(request, 'e2e-stale');
    expect(after.paused).toBe(false);
    expect(after.hash).toBe(edited.hash);

    // Delete is refused the same way, and the file stays.
    await root.getByRole('button', { name: WORKFLOW_COPY.deleteAction }).click();
    await page
      .getByRole('dialog', { name: WORKFLOW_COPY.deleteDialog.title })
      .getByRole('button', { name: WORKFLOW_COPY.deleteDialog.confirm })
      .click();
    await expect(root).toHaveAttribute('data-condition', 'stale');
    expect(await workflowFaultCode(request, 'e2e-stale')).toBeUndefined();

    // Reload shows what is on disk, and then pause works.
    await root.getByRole('button', { name: WORKFLOW_COPY.stale.action }).click();
    await expect(root).toHaveAttribute('data-condition', 'ready');
    await expect(root.getByTestId('workflow-trigger')).toHaveText(
      describeCadence({ intervalMs: 12 * 3_600_000 }),
    );
    await root.getByRole('button', { name: WORKFLOW_COPY.pauseAction }).click();
    await expect(root.getByRole('button', { name: WORKFLOW_COPY.resumeAction })).toBeVisible();
    const paused = await readWorkflow(request, 'e2e-stale');
    expect(paused.paused).toBe(true);
  });
});

test.describe('send signal', () => {
  test('starts an instance, then moves it from running to completed', async ({
    page,
    request,
    checkA11y,
  }) => {
    const id = SEEDED_WORKFLOWS.approval;
    await page.goto(`/workflows/${id}`);
    const form = detail(page).getByTestId('workflow-signal');
    const name = form.getByRole('textbox', { name: WORKFLOW_COPY.signal.nameLabel });
    // The trigger is a signal, so its name is where the form starts.
    await expect(name).toHaveValue(APPROVAL_START_SIGNAL);
    await checkA11y('the send-signal form');

    const before = await listWorkflowRuns(request, id);
    const waiting = before.filter((run) => run.status === 'running');
    await form.getByRole('button', { name: WORKFLOW_COPY.signal.sendAction }).click();
    // The signal started one instance, and reached the ones already waiting for it by that name: none.
    await expect(
      form.getByRole('status', { name: WORKFLOW_COPY.signal.resultLabel }),
    ).toContainText(WORKFLOW_COPY.signal.result(1, 0));
    // The page's runs take the new instance without a reload.
    await detail(page).getByRole('tab', { name: WORKFLOW_COPY.page.tabs.runs }).click();
    await expect(detail(page).locator('[data-run]').first()).toBeVisible();
    await detail(page).getByRole('tab', { name: WORKFLOW_COPY.page.tabs.overview }).click();
    const after = await listWorkflowRuns(request, id);
    const running = after.filter((run) => run.status === 'running');
    expect(running).toHaveLength(waiting.length + 1);
    const instance = running.find((run) => !waiting.some((older) => older.id === run.id));
    expect(instance).toBeDefined();
    if (instance === undefined) return;

    // The instance waits for the other signal. Send it with a payload; the instance takes it and finishes.
    await name.fill(APPROVAL_SIGNAL);
    await form
      .getByRole('textbox', { name: WORKFLOW_COPY.signal.payloadLabel })
      .fill('{"approved": true}');
    await expect(async () => {
      await form.getByRole('button', { name: WORKFLOW_COPY.signal.sendAction }).click();
      await expect(
        form.getByRole('status', { name: WORKFLOW_COPY.signal.resultLabel }),
      ).toContainText(WORKFLOW_COPY.signal.result(0, waiting.length + 1));
    }).toPass();
    await expect.poll(() => workflowRunStatus(request, instance.id)).toBe('completed');
  });

  test('says how many were started and reached, and refuses a payload that is not JSON', async ({
    page,
  }) => {
    await page.goto(`/workflows/${SEEDED_WORKFLOWS.digest}`);
    const form = detail(page).getByTestId('workflow-signal');
    // No step of the digest waits for a signal, so the form starts empty.
    const name = form.getByRole('textbox', { name: WORKFLOW_COPY.signal.nameLabel });
    await expect(name).toHaveValue('');
    await name.fill('e2e-nobody-waits');
    await form.getByRole('textbox', { name: WORKFLOW_COPY.signal.payloadLabel }).fill('{ nope');
    await form.getByRole('button', { name: WORKFLOW_COPY.signal.sendAction }).click();
    await expect(form).toContainText(WORKFLOW_COPY.signal.invalidPayload);
    await form.getByRole('textbox', { name: WORKFLOW_COPY.signal.payloadLabel }).fill('');
    await form.getByRole('button', { name: WORKFLOW_COPY.signal.sendAction }).click();
    await expect(
      form.getByRole('status', { name: WORKFLOW_COPY.signal.resultLabel }),
    ).toContainText(WORKFLOW_COPY.signal.result(0, 0));
  });
});

test.describe('the runs of a type', () => {
  for (const width of WIDTHS) {
    test(`are the runs list filtered by the type, and each row links to its run, at ${width} pixels`, async ({
      page,
      checkA11y,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/workflows/inventory-sync-sweep?tab=runs');
      await detail(page).getByRole('link', { name: WORKFLOW_COPY.runsAction }).click();
      await expect(page).toHaveURL(/\/workflows\/inventory-sync-sweep\/runs$/);
      await expect(area(page)).toHaveAttribute('data-state', 'ready');
      const rows = page.locator('tbody tr');
      await expect(rows.first()).toBeVisible();
      // Every row is a run of this type.
      const texts = await rows.allTextContents();
      expect(texts.length).toBeGreaterThan(0);
      for (const text of texts) expect(text).toContain('inventory-sync-sweep');
      await checkA11y(`the runs of a type at ${width}px`);

      // A row opens its run, and the run’s type links back to the type.
      await rows.first().getByRole('link').first().click();
      await expect(page).toHaveURL(/\/runs\/[^/]+$/);
      const link = page.getByRole('link', { name: 'inventory-sync-sweep' });
      await expect(link).toHaveAttribute('href', '/workflows/inventory-sync-sweep');
      await link.click();
      await expect(page).toHaveURL(/\/workflows\/inventory-sync-sweep$/);
      await expect(detail(page)).toBeVisible();
    });
  }

  test('say there are none for a type that never ran', async ({ page, checkA11y }) => {
    await page.goto(`/workflows/${SEEDED_WORKFLOWS.digest}/runs`);
    await expect(area(page)).toHaveAttribute('data-state', 'empty');
    await expect(area(page).getByRole('heading', { level: 1 })).toHaveText(
      VIEW_COPY.workflows.emptyByPattern?.['/workflows/:workflow/runs']?.title ?? '',
    );
    await checkA11y('the runs of a type with none');
  });
});

test.describe('the editor', () => {
  for (const width of WIDTHS) {
    test(`saves the file’s JSON without its name, and lands on the workflow, at ${width} pixels`, async ({
      page,
      request,
      checkA11y,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await makeWorkflow(request, 'e2e-editable');
      await page.goto('/workflows/e2e-editable/edit');
      const root = page.locator('[data-page="workflow-editor"]');
      await expect(area(page)).toHaveAttribute('data-state', 'ready');
      await expect(root.getByTestId('workflow-file-path')).toHaveText(
        await workflowFilePath(request, 'e2e-editable'),
      );
      const editor = await jsonEditor(root, WORKFLOW_COPY.editor.textLabel);
      const text = JSON.parse(await jsonEditorSource(editor)) as Record<string, unknown>;
      // The file's own name is there to read, and is not sent.
      expect(text['name']).toBe('e2e-editable');
      text['trigger'] = { kind: 'schedule', spec: '6h' };
      await editor.fill(JSON.stringify(text, null, 2));
      await checkA11y(`the editor at ${width}px`);
      await root.getByRole('button', { name: WORKFLOW_COPY.editor.saveAction }).click();

      await expect(page).toHaveURL(/\/workflows\/e2e-editable$/);
      await expect(detail(page).getByTestId('workflow-trigger')).toHaveText(
        describeCadence({ intervalMs: 6 * 3_600_000 }),
      );
      const saved = JSON.parse(
        await readFile(await workflowFilePath(request, 'e2e-editable'), 'utf8'),
      ) as Record<string, unknown>;
      expect(saved['trigger']).toEqual({ kind: 'schedule', spec: '6h' });
      expect(saved['name']).toBe('e2e-editable');
    });
  }

  test('shows the error for JSON that is not valid, and for a document the Bureau refuses, and saves neither', async ({
    page,
    request,
  }) => {
    await makeWorkflow(request, 'e2e-refused');
    const before = await readWorkflow(request, 'e2e-refused');
    await page.goto('/workflows/e2e-refused/edit');
    const root = page.locator('[data-page="workflow-editor"]');
    const editor = await jsonEditor(root, WORKFLOW_COPY.editor.textLabel);

    await editor.fill('{ "trigger": ');
    await root.getByRole('button', { name: WORKFLOW_COPY.editor.saveAction }).click();
    await expect(root).toContainText(WORKFLOW_COPY.editor.notJson);

    await editor.fill(
      JSON.stringify({ trigger: { kind: 'schedule', spec: 'never ever' }, steps: [] }),
    );
    await root.getByRole('button', { name: WORKFLOW_COPY.editor.saveAction }).click();
    await expect(root).toContainText(WORKFLOW_COPY.editor.saveFailed);
    await expect(page).toHaveURL(/\/workflows\/e2e-refused\/edit$/);
    const unchanged = await readWorkflow(request, 'e2e-refused');
    expect(unchanged.hash).toBe(before.hash);
  });

  test('is the changed-outside state when the file changed, and reloading discards the edits', async ({
    page,
    request,
  }) => {
    await makeWorkflow(request, 'e2e-edit-stale');
    await page.goto('/workflows/e2e-edit-stale/edit');
    const root = page.locator('[data-page="workflow-editor"]');
    const editor = await jsonEditor(root, WORKFLOW_COPY.editor.textLabel);
    await expect(editor).toBeVisible();

    const before = await readWorkflow(request, 'e2e-edit-stale');
    await bureau(request, 'bureau.workflows.update', {
      id: 'e2e-edit-stale',
      expectedHash: before.hash,
      definition: {
        ...(JSON.parse(before.text ?? '{}') as Record<string, unknown>),
        name: undefined,
        trigger: { kind: 'schedule', spec: '8h' },
      },
    });
    await editor.fill(JSON.stringify({ trigger: { kind: 'schedule', spec: '2h' }, steps: STEPS }));
    await root.getByRole('button', { name: WORKFLOW_COPY.editor.saveAction }).click();
    await expect(root).toHaveAttribute('data-condition', 'stale');
    await expect(root).toContainText(WORKFLOW_COPY.stale.title);

    await root.getByRole('button', { name: WORKFLOW_COPY.stale.action }).click();
    await expect(root).toHaveAttribute('data-condition', 'ready');
    await expect(editor).toHaveText(/8h/);
    await expect(editor).not.toHaveText(/2h/);
  });

  test('opens an invalid file with its problem and its path, and lets it be fixed', async ({
    page,
    request,
    checkA11y,
  }) => {
    const path = await workflowFilePath(request, 'e2e-fixable');
    created.add('e2e-fixable');
    await writeFile(
      path,
      JSON.stringify({
        name: 'e2e-fixable',
        trigger: { kind: 'schedule', spec: 'never' },
        steps: [],
      }),
    );
    // The Bureau notices a hand-written file within a second.
    await expect.poll(() => workflowFaultCode(request, 'e2e-fixable')).toBeUndefined();

    await page.goto('/workflows/e2e-fixable/edit');
    const root = page.locator('[data-page="workflow-editor"]');
    await expect(root).toHaveAttribute('data-condition', 'invalid');
    await expect(root.getByTestId('workflow-problem')).toContainText('invalid-document');
    await expect(root.getByTestId('workflow-file-path')).toHaveText(path);
    await checkA11y('an invalid file in the editor');

    const editor = await jsonEditor(root, WORKFLOW_COPY.editor.textLabel);
    await editor.fill(JSON.stringify({ trigger: { kind: 'schedule', spec: '1h' }, steps: STEPS }));
    await root.getByRole('button', { name: WORKFLOW_COPY.editor.saveAction }).click();
    await expect(page).toHaveURL(/\/workflows\/e2e-fixable$/);
    const fixed = await readWorkflow(request, 'e2e-fixable');
    expect(fixed.state).toBe('ready');
  });
});

test.describe('a type that does not exist', () => {
  for (const path of [
    '/workflows/e2e-nobody',
    '/workflows/e2e-nobody/runs',
    '/workflows/e2e-nobody/edit',
  ]) {
    for (const width of WIDTHS) {
      test(`${path} is not found, at ${width} pixels`, async ({ page, checkA11y }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(path);
        await expect(area(page)).toHaveAttribute('data-state', 'not-found');
        await expect(area(page).getByRole('heading', { level: 1 })).toBeVisible();
        await checkA11y(`${path} at ${width}px`);
      });
    }
  }

  test('a code-defined type has no editor, and is not found there', async ({ page }) => {
    await page.goto('/workflows/inventory-sync-sweep/edit');
    await expect(area(page)).toHaveAttribute('data-state', 'not-found');
  });
});
