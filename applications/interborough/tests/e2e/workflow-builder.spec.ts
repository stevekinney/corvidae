/**
 * The workflow builder against the real host, on `/workflows/new` and `/workflows/:workflow/edit`
 * (board PageWorkflowBuilder): a workflow built from cards saves as a file the Bureau lists as ready
 * and runs, a title makes the ID and is written as the file's `title`, a wait for a person is an
 * `await-signal` with `review: true`, the JSON tab and the builder show each other's edits, ⌘Enter
 * saves from a field, and a file that changed on disk keeps the draft on the page. Below 640 pixels
 * the builder is read-only and says to open it on a larger screen (row 05n). Each page meets axe at
 * the two widths the application is built for.
 */
import type { Locator, Page } from '@playwright/test';
import { rm } from 'node:fs/promises';

import { WORKFLOW_COPY } from '../../src/app/copy/workflows.ts';
import { bureau } from './agent-support.ts';
import { expect, test } from './fixtures.ts';
import { jsonEditor, jsonEditorSource } from './json-editor-support.ts';
import { expectEngineMissesForFileRuns } from './task-support.ts';
import {
  answerEmptyActivityCatalog,
  createWorkflowFile,
  expectTabOpen,
  listWorkflowRuns,
  openJsonTab,
  openTab,
  readWorkflow,
  removeWorkflow,
  workflowFaultCode,
  workflowFilePath,
  workflowRunStatus,
} from './workflow-support.ts';

const BUILDER = WORKFLOW_COPY.builder;
const DESKTOP = { width: 1280, height: 900 } as const;
const PHONE = { width: 375, height: 900 } as const;

const area = (page: Page) => page.locator('[data-view="workflows"]');
const creator = (page: Page) => page.locator('[data-page="workflow-creator"]');
const editor = (page: Page) => page.locator('[data-page="workflow-editor"]');

/** The name of a top-level step in a label: "step 1". */
const step = BUILDER.where.step;

/**
 * Adds a step by its exact words in the menu of "Add a step", which opens from the one button under
 * the steps: "Wait" is also the start of two other items.
 */
async function addStep(root: Locator, label: string): Promise<void> {
  await root.getByRole('button', { name: BUILDER.addLabel, exact: true }).click();
  await root.page().getByRole('menuitem', { name: label, exact: true }).click();
}

/**
 * Replaces the new workflow's empty agent step with a wait, so an untouched form becomes a file
 * the Bureau accepts without naming an agent.
 */
async function waitInsteadOfAgent(root: Locator): Promise<void> {
  await addStep(root, BUILDER.add.wait);
  await root.getByRole('button', { name: BUILDER.remove(step(1)) }).click();
}

/** Identifiers this file's specs create, removed after each spec. */
const created = new Set<string>();

// The Add a step menu asks for the catalog of activities, which the Bureau does not serve yet.
test.beforeEach(async ({ page }) => {
  await answerEmptyActivityCatalog(page);
});

test.afterEach(async ({ request }) => {
  for (const id of created) {
    await removeWorkflow(request, id);
    await rm(await workflowFilePath(request, id), { force: true });
  }
  created.clear();
});

test.describe('a workflow built from cards', () => {
  test('saves as a ready file with its title, and runs to the end', async ({
    page,
    request,
    checkA11y,
    pageErrors,
  }) => {
    expectEngineMissesForFileRuns(pageErrors);
    const id = 'e2e-built';
    created.add(id);
    await page.setViewportSize(DESKTOP);
    await page.goto('/workflows/new');
    await expect(area(page)).toHaveAttribute('data-state', 'ready');
    const root = creator(page);
    await expectTabOpen(root, BUILDER.builderTab);
    await expect(root.getByRole('radio', { name: BUILDER.triggers.manual })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await checkA11y('the builder at 1280px');

    await root.getByLabel(BUILDER.titleLabel, { exact: true }).fill('E2E built');
    await expect(root.getByTestId('workflow-builder-id-line')).toContainText(id);
    await root.getByLabel(BUILDER.descriptionLabel, { exact: true }).fill('Built from cards.');
    await root.getByRole('radio', { name: BUILDER.triggers.signal }).click();
    await root.getByLabel(BUILDER.signalNameLabel).fill('e2e-built-go');
    // The empty agent step goes, and a signal wait takes its place.
    await addStep(root, BUILDER.add.signal);
    await root.getByRole('button', { name: BUILDER.remove(step(1)) }).click();
    await root.getByLabel(BUILDER.signalLabel(step(1))).fill('e2e-built-wait');
    await root.getByLabel(BUILDER.stepName(step(1))).fill('Wait for the go-ahead');
    await expect(root.getByTestId('workflow-builder-summary')).toContainText(
      'Each time e2e-built-go is sent, wait for e2e-built-wait.',
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

  test('writes a title, a step name, and a wait for a person in the file format', async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto('/workflows/new');
    await expect(area(page)).toHaveAttribute('data-state', 'ready');
    const root = creator(page);
    await root.getByLabel(BUILDER.titleLabel, { exact: true }).fill('Morning Briefing');
    await addStep(root, BUILDER.add.person);
    await root.getByLabel(BUILDER.stepName(step(2))).fill('Review the briefing');
    await expect(root.locator('[data-step-kind="person"]')).toContainText(
      BUILDER.personDescription,
    );

    await openJsonTab(root);
    const json = await jsonEditor(root, WORKFLOW_COPY.creator.textLabel);
    const document = JSON.parse(await jsonEditorSource(json)) as Record<string, unknown>;
    expect(document).toMatchObject({
      name: 'morning-briefing',
      title: 'Morning Briefing',
      trigger: { kind: 'manual' },
    });
    expect((document['steps'] as unknown[])[1]).toEqual({
      title: 'Review the briefing',
      kind: 'await-signal',
      signal: expect.stringMatching(/^review-[0-9a-f]{8}$/),
      review: true,
    });
  });

  test('shows a JSON edit in the builder, and a builder edit in the JSON', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto('/workflows/new');
    const root = creator(page);
    await expect(area(page)).toHaveAttribute('data-state', 'ready');

    await root.getByLabel(BUILDER.idLabel, { exact: true }).fill('e2e-synced');
    await addStep(root, BUILDER.add.wait);
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
    await openTab(root, BUILDER.builderTab);
    await expect(root.getByLabel(BUILDER.durationLabel(step(1)))).toHaveValue('45');
    await expect(root.getByLabel(BUILDER.unitLabel(step(1)))).toHaveValue('seconds');
    await expect(root.getByLabel(BUILDER.agentLabel(step(1)))).toHaveCount(0);
  });

  test('saves with ⌘Enter from a field', async ({ page, request }) => {
    const id = 'e2e-keyboard';
    created.add(id);
    await page.setViewportSize(DESKTOP);
    await page.goto('/workflows/new');
    await expect(area(page)).toHaveAttribute('data-state', 'ready');
    const root = creator(page);
    await waitInsteadOfAgent(root);
    const name = root.getByLabel(BUILDER.idLabel, { exact: true });
    await name.fill(id);
    await name.press('ControlOrMeta+Enter');

    await expect(page).toHaveURL(new RegExp(`/workflows/${id}$`));
    const saved = await readWorkflow(request, id);
    expect(saved.state).toBe('ready');
  });

  test('is read-only below 640 pixels, and links back to Workflows', async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize(PHONE);
    await page.goto('/workflows/new');
    await expect(area(page)).toHaveAttribute('data-state', 'ready');
    const root = creator(page);
    const notice = root.getByTestId('workflow-builder-phone');
    await expect(notice).toContainText(BUILDER.phone.message);
    await expect(notice.getByRole('link', { name: BUILDER.phone.backToWorkflows })).toHaveAttribute(
      'href',
      '/workflows',
    );
    await expect(root.locator('.weft-workflow-builder__body')).toHaveAttribute('inert', '');
    await checkA11y('the builder at 375px');
  });
});

test.describe('the builder’s fields', () => {
  test('does not save on plain Enter in a field', async ({ page, request }) => {
    const id = 'e2e-plain-enter';
    created.add(id);
    await page.setViewportSize(DESKTOP);
    await page.goto('/workflows/new');
    await expect(area(page)).toHaveAttribute('data-state', 'ready');
    const root = creator(page);
    await waitInsteadOfAgent(root);
    const name = root.getByLabel(BUILDER.idLabel, { exact: true });
    await name.fill(id);
    await name.press('Enter');
    await root.getByLabel(BUILDER.durationLabel(step(1))).press('Enter');
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
    await page.setViewportSize(DESKTOP);
    await page.goto('/workflows/new');
    await expect(area(page)).toHaveAttribute('data-state', 'ready');
    const root = creator(page);
    await root.getByLabel(BUILDER.idLabel, { exact: true }).fill(id);
    // The first agent the host lists, after the placeholder that chooses none.
    await root.getByLabel(BUILDER.agentLabel(step(1))).selectOption({ index: 1 });
    await root.getByLabel(BUILDER.messageLabel(step(1))).fill(message);
    await root.getByLabel(BUILDER.descriptionLabel, { exact: true }).fill('Multi-line.');
    await expect(root.getByLabel(BUILDER.messageLabel(step(1)))).toHaveValue(message);

    await root.getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }).click();
    await expect(page).toHaveURL(new RegExp(`/workflows/${id}$`));
    await page.goto(`/workflows/${id}/edit`);
    await expect(editor(page).getByLabel(BUILDER.messageLabel(step(1)))).toHaveValue(message);
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
    await page.setViewportSize(DESKTOP);
    await page.goto(`/workflows/${id}/edit`);
    await expect(area(page)).toHaveAttribute('data-state', 'ready');
    const root = editor(page);
    // An existing workflow's ID is a read-only line, not a field.
    const idLine = root.getByTestId('workflow-builder-id-line');
    await expect(idLine.locator('code')).toHaveText(id);
    await expect(idLine.locator('input')).toHaveCount(0);

    const before = await readWorkflow(request, id);
    await bureau(request, 'bureau.workflows.update', {
      id,
      expectedHash: before.hash,
      definition: {
        trigger: { kind: 'schedule', spec: '9h' },
        steps: [{ kind: 'sleep', duration: '1m' }],
      },
    });

    await root.getByLabel(BUILDER.durationLabel(step(1))).fill('5');
    await root.getByRole('button', { name: WORKFLOW_COPY.editor.saveAction }).click();
    await expect(root.getByText(WORKFLOW_COPY.editor.changedOnDisk.title)).toBeVisible();
    await expect(root.getByLabel(BUILDER.durationLabel(step(1)))).toHaveValue('5');
    await expect(page).toHaveURL(new RegExp(`/workflows/${id}/edit$`));
  });
});
