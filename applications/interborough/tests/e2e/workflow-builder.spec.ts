/**
 * The workflow step builder against the real host, on `/workflows/new` and
 * `/workflows/:workflow/edit`: a workflow built from rows saves as a file the Bureau lists as ready
 * and runs, the JSON tab and the builder show each other's edits, ⌘Enter saves from a field, and a
 * file that changed on disk keeps the draft on the page. Each page meets axe at the two widths the
 * application is built for.
 */
import type { Page } from '@playwright/test';
import { rm } from 'node:fs/promises';

import { WORKFLOW_COPY } from '../../src/app/copy.ts';
import { bureau } from './agent-support.ts';
import { expect, test } from './fixtures.ts';
import { jsonEditor, jsonEditorSource } from './json-editor-support.ts';
import { expectEngineMissesForFileRuns } from './task-support.ts';
import {
  createWorkflowFile,
  listWorkflowRuns,
  openJsonTab,
  readWorkflow,
  removeWorkflow,
  workflowFaultCode,
  workflowFilePath,
  workflowRunStatus,
} from './workflow-support.ts';

const WIDTHS = [375, 1280] as const;
const BUILDER = WORKFLOW_COPY.builder;

const area = (page: Page) => page.locator('[data-view="workflows"]');
const creator = (page: Page) => page.locator('[data-page="workflow-creator"]');
const editor = (page: Page) => page.locator('[data-page="workflow-editor"]');

/** Identifiers this file's specs create, removed after each spec. */
const created = new Set<string>();

test.afterEach(async ({ request }) => {
  for (const id of created) {
    await removeWorkflow(request, id);
    await rm(await workflowFilePath(request, id), { force: true });
  }
  created.clear();
});

test.describe('a workflow built from rows', () => {
  for (const width of WIDTHS) {
    test(`saves as a ready file and runs to the end, at ${width} pixels`, async ({
      page,
      request,
      checkA11y,
      pageErrors,
    }) => {
      expectEngineMissesForFileRuns(pageErrors);
      const id = 'e2e-built';
      created.add(id);
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/workflows/new');
      await expect(area(page)).toHaveAttribute('data-state', 'ready');
      const root = creator(page);
      await expect(root.getByRole('tab', { name: BUILDER.builderTab })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await checkA11y(`the builder at ${width}px`);

      await root.getByLabel(BUILDER.nameLabel, { exact: true }).fill(id);
      await root.getByLabel(BUILDER.descriptionLabel, { exact: true }).fill('Built from rows.');
      await root
        .getByLabel(BUILDER.triggerKindLabel)
        .selectOption({ label: BUILDER.triggerKinds.signal });
      await root.getByLabel(BUILDER.signalNameLabel).fill('e2e-built-go');
      // The template's agent step goes, and a signal wait takes its place.
      await root.getByRole('button', { name: BUILDER.addSignal }).click();
      await root.getByRole('button', { name: BUILDER.remove(1) }).click();
      await root.getByLabel(BUILDER.signalLabel(1)).fill('e2e-built-wait');
      await expect(root.getByTestId('workflow-builder-summary')).toContainText(
        WORKFLOW_COPY.steps.awaitSignal('e2e-built-wait'),
      );

      await root.getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }).click();
      await expect(page).toHaveURL(new RegExp(`/workflows/${id}$`));
      const made = await readWorkflow(request, id);
      expect(made.state).toBe('ready');

      await page.getByRole('link', { name: WORKFLOW_COPY.page.startAction }).click();
      await page.getByRole('button', { name: WORKFLOW_COPY.runSetup.startAction }).click();
      await expect(page).toHaveURL(new RegExp(`/workflows/${id}/runs/[^/]+$`));
      const [run] = await listWorkflowRuns(request, id);
      expect(run?.status).toBe('running');
      await expect
        .poll(async () => {
          await bureau(request, 'bureau.workflows.signal', { name: 'e2e-built-wait' });
          return run === undefined ? undefined : workflowRunStatus(request, run.id);
        })
        .toBe('completed');
    });
  }

  test('shows a JSON edit in the builder, and a builder edit in the JSON', async ({ page }) => {
    await page.goto('/workflows/new');
    const root = creator(page);
    await expect(area(page)).toHaveAttribute('data-state', 'ready');

    await root.getByLabel(BUILDER.nameLabel, { exact: true }).fill('e2e-synced');
    await root.getByRole('button', { name: BUILDER.addWait }).click();
    await openJsonTab(root);
    const json = await jsonEditor(root, WORKFLOW_COPY.creator.textLabel);
    const document = JSON.parse(await jsonEditorSource(json)) as {
      name: string;
      steps: Record<string, unknown>[];
    };
    expect(document.name).toBe('e2e-synced');
    expect(document.steps.at(-1)).toEqual({ kind: 'sleep', duration: '1m' });

    document.steps = [{ kind: 'sleep', duration: '45s' }];
    await json.fill(JSON.stringify(document, null, 2));
    await root.getByRole('tab', { name: BUILDER.builderTab }).click();
    await expect(root.getByLabel(BUILDER.durationLabel(1))).toHaveValue('45s');
    await expect(root.getByLabel(BUILDER.agentLabel(1))).toHaveCount(0);
  });

  test('saves with ⌘Enter from a field', async ({ page, request }) => {
    const id = 'e2e-keyboard';
    created.add(id);
    await page.goto('/workflows/new');
    await expect(area(page)).toHaveAttribute('data-state', 'ready');
    const name = creator(page).getByLabel(BUILDER.nameLabel, { exact: true });
    await name.fill(id);
    await name.press('ControlOrMeta+Enter');

    await expect(page).toHaveURL(new RegExp(`/workflows/${id}$`));
    const saved = await readWorkflow(request, id);
    expect(saved.state).toBe('ready');
  });
});

test.describe('the builder’s fields', () => {
  test('does not save on plain Enter in a field', async ({ page, request }) => {
    const id = 'e2e-plain-enter';
    created.add(id);
    await page.goto('/workflows/new');
    await expect(area(page)).toHaveAttribute('data-state', 'ready');
    const root = creator(page);
    const name = root.getByLabel(BUILDER.nameLabel, { exact: true });
    await name.fill(id);
    await name.press('Enter');
    await root.getByLabel(BUILDER.scheduleLabel).press('Enter');
    await expect(
      root.getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }),
    ).toBeEnabled();
    await expect(page).toHaveURL(/\/workflows\/new$/);
    expect(await workflowFaultCode(request, id)).toBeDefined();

    await root.getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }).click();
    await expect(page).toHaveURL(new RegExp(`/workflows/${id}$`));
  });

  test('keeps a multi-line message as written through an edit and a save', async ({ page }) => {
    const id = 'e2e-multi-line';
    created.add(id);
    const message = 'First line.\n\nThird line.';
    await page.goto('/workflows/new');
    await expect(area(page)).toHaveAttribute('data-state', 'ready');
    const root = creator(page);
    await root.getByLabel(BUILDER.nameLabel, { exact: true }).fill(id);
    await root.getByLabel(BUILDER.messageLabel(1)).fill(message);
    await root.getByLabel(BUILDER.scheduleLabel).fill('2h');
    await expect(root.getByLabel(BUILDER.messageLabel(1))).toHaveValue(message);

    await root.getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }).click();
    await expect(page).toHaveURL(new RegExp(`/workflows/${id}$`));
    await page.goto(`/workflows/${id}/edit`);
    await expect(editor(page).getByLabel(BUILDER.messageLabel(1))).toHaveValue(message);
  });
});

test.describe('the editor’s builder', () => {
  test('keeps the draft on the page when the file changed underneath it', async ({
    page,
    request,
  }) => {
    const id = 'e2e-builder-stale';
    created.add(id);
    await createWorkflowFile(request, id, {
      trigger: { kind: 'schedule', spec: '1h' },
      steps: [{ kind: 'sleep', duration: '1m' }],
    });
    await page.goto(`/workflows/${id}/edit`);
    await expect(area(page)).toHaveAttribute('data-state', 'ready');
    const root = editor(page);
    const name = root.getByLabel(BUILDER.nameLabel, { exact: true });
    await expect(name).toHaveValue(id);
    await expect(name).toHaveJSProperty('readOnly', true);

    const before = await readWorkflow(request, id);
    await bureau(request, 'bureau.workflows.update', {
      id,
      expectedHash: before.hash,
      definition: {
        trigger: { kind: 'schedule', spec: '9h' },
        steps: [{ kind: 'sleep', duration: '1m' }],
      },
    });

    await root.getByLabel(BUILDER.durationLabel(1)).fill('5m');
    await root.getByRole('button', { name: WORKFLOW_COPY.editor.saveAction }).click();
    await expect(root.getByText(WORKFLOW_COPY.stale.title)).toBeVisible();
    await expect(root.getByLabel(BUILDER.durationLabel(1))).toHaveValue('5m');
    await expect(page).toHaveURL(new RegExp(`/workflows/${id}/edit$`));
  });
});
