/**
 * `/workflows/:workflow/run` against the real host: the workflow is fixed by the address, the
 * input is a form drawn from the file's schema, an invalid input shows its field errors and
 * creates no run, and plain Enter never starts one. Start run on the workflow page and on Runs
 * (through the picker) reaches the page, and On a schedule creates a schedule in the chosen zone.
 */
import type { Page } from '@playwright/test';
import { rm } from 'node:fs/promises';

import { WORKFLOW_COPY } from '../../src/app/copy/workflows.ts';
import { bureau } from './agent-support.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { expect, test } from './fixtures.ts';
import { jsonEditor, replaceJsonEditorText } from './json-editor-support.ts';
import { expectEngineMissesForFileRuns } from './task-support.ts';
import {
  createWorkflowFile,
  listWorkflowRuns,
  readWorkflow,
  removeWorkflow,
  workflowFilePath,
  workflowRunStatus,
} from './workflow-support.ts';

const COPY = WORKFLOW_COPY.runSetup;
const WIDTHS = [375, 1280] as const;
const SOURCE = 'run-setup.spec.ts';

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

/** A run setup with the typed fields the board shows, without an automatic trigger in the test. */
async function createReleaseSetup(request: Parameters<typeof createWorkflowFile>[0], id: string) {
  created.add(id);
  await createWorkflowFile(request, id, {
    title: 'Release notes',
    description: 'Collects merged changes into a draft.',
    trigger: { kind: 'signal', name: `${id}-go` },
    steps: [{ kind: 'await-signal', signal: `${id}-wait` }],
    inputSchema: {
      type: 'object',
      properties: {
        branch: { type: 'string', title: 'Branch', examples: ['such as main'] },
        since: { type: 'string', title: 'Since', format: 'date' },
      },
      required: ['branch'],
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

test.describe('the run setup page at /workflows/:workflow/run and its queued result at /runs', () => {
  test('57f, 58a, 58b, 58c and 58z: names the workflow, lays out Input and When, and pins the action', async ({
    page,
    request,
    checkA11y,
  }) => {
    const id = 'e2e-setup-layout';
    await createWaiting(request, id);
    // The footer reads the Bureau's executing-run snapshot. The fixture host owns no such runs
    // here, so the layout state has a free slot; the at-limit state is captured separately below.
    await page.route('**/jsonrpc', async (route) => {
      const body = JSON.parse(route.request().postData() ?? '{}') as {
        method?: string;
        id?: unknown;
      };
      if (body.method !== 'bureau.workflows.concurrency') {
        await route.fallback();
        return;
      }
      await route.fulfill({
        json: { jsonrpc: '2.0', id: body.id, result: { max: 4, running: 0 } },
      });
    });
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
      await expect(footer(page).getByTestId('run-setup-summary')).toHaveText(COPY.summaryNow());
      await expect(footer(page).getByRole('button', { name: COPY.startAction })).toBeVisible();
      await captureForDesignReview(page, {
        route: '/workflows/:workflow/run',
        state: '57f-required-form-and-58a-58c-schema',
        source: SOURCE,
      });
      await checkA11y(`run setup at ${width}px`);
    }
  });

  test('58d: shows the field errors of an invalid input and creates no run', async ({
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
    await captureForDesignReview(page, {
      route: '/workflows/:workflow/run',
      state: '58d-required-input-invalid',
      source: SOURCE,
    });
    expect(await listWorkflowRuns(request, id)).toEqual([]);
  });

  test('58a–58c: large authored input opens required fields and folds optional groups', async ({
    page,
    request,
  }) => {
    const id = 'e2e-setup-large';
    created.add(id);
    await createWorkflowFile(request, id, {
      title: 'Release notes',
      trigger: { kind: 'manual' },
      inputSchema: {
        type: 'object',
        properties: {
          ...Object.fromEntries(
            [
              'Target',
              'Audience',
              'Template',
              'Version',
              'Channel',
              'Reviewer',
              'Milestone',
              'Format',
            ].map((name) => [name.toLowerCase(), { type: 'string', title: name }]),
          ),
          branch: { type: 'string', title: 'Branch', default: 'main' },
          options: {
            type: 'object',
            title: 'Options',
            properties: { draft: { type: 'boolean', title: 'Draft', default: true } },
          },
        },
        required: ['branch'],
      },
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/workflows/${id}/run`);
    await expect(setup(page).getByLabel(/^Branch/)).toBeVisible();
    await expect(setup(page).getByLabel('Find a field')).toBeVisible();
    await expect(setup(page).getByRole('button', { name: /^Options/ })).toBeVisible();
    await captureForDesignReview(page, {
      route: '/workflows/:workflow/run',
      state: '58a-58c-large-schema',
      source: SOURCE,
    });
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

  test('58o and 58p: a refused start stays at the footer and Start run remains the retry', async ({
    page,
    request,
  }) => {
    const id = 'e2e-setup-refused-start';
    await createWaiting(request, id);
    await page.route('**/jsonrpc', async (route) => {
      const body = route.request().postDataJSON() as { id?: unknown; method?: string };
      if (body.method !== 'bureau.workflows.start') return route.fallback();
      await route.fulfill({
        json: {
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32000, message: 'Interborough didn’t answer.' },
        },
      });
    });
    await page.goto(`/workflows/${id}/run`);
    await expect(area(page)).toHaveAttribute('data-state', 'ready');
    await setup(page).getByLabel('Topic').fill('weather');
    await footer(page).getByRole('button', { name: COPY.startAction }).click();
    const failure = setup(page).getByTestId('run-setup-failure');
    await expect(failure).toContainText(COPY.startFailed);
    await expect(failure).toContainText(COPY.nothingStarted);
    await expect(footer(page).getByRole('button', { name: COPY.startAction })).toBeEnabled();
    await expect(setup(page).getByRole('button', { name: 'Try again' })).toHaveCount(0);
    await captureForDesignReview(page, {
      route: '/workflows/:workflow/run',
      state: '58o-58p-start-refused-and-retry',
      source: SOURCE,
    });
    expect(await listWorkflowRuns(request, id)).toEqual([]);
  });

  test('Cancel returns to the workflow', async ({ page, request }) => {
    const id = 'e2e-setup-cancel';
    await createWaiting(request, id);
    await page.goto(`/workflows/${id}/run`);
    await expect(area(page)).toHaveAttribute('data-state', 'ready');
    await footer(page).getByRole('button', { name: COPY.cancel }).click();
    await expect(page).toHaveURL(new RegExp(`/workflows/${id}$`));
  });

  test('58f: keeps the actual paused workflow form visible and disables Start run', async ({
    page,
    request,
  }) => {
    const id = 'e2e-setup-paused';
    created.add(id);
    await createWorkflowFile(request, id, {
      paused: true,
      trigger: { kind: 'manual' },
      description: 'Sorts new messages into the right folder and flags anything urgent.',
      inputSchema: { type: 'object', properties: { topic: { type: 'string', title: 'Topic' } } },
    });
    await page.goto(`/workflows/${id}/run`);
    await expect(area(page)).toHaveAttribute('data-state', 'ready');
    await expect(setup(page).getByTestId('run-setup-paused')).toBeVisible();
    await expect(footer(page).getByRole('button', { name: COPY.startAction })).toBeDisabled();
    await captureForDesignReview(page, {
      route: '/workflows/:workflow/run',
      state: '58f-paused',
      source: SOURCE,
    });
  });

  test('58i and 58z: gives a no-input workflow an at-limit footer from Bureau concurrency', async ({
    page,
    request,
  }) => {
    const id = 'e2e-setup-no-input-limit';
    created.add(id);
    await createWorkflowFile(request, id, {
      trigger: { kind: 'signal', name: `${id}-go` },
      steps: [{ kind: 'await-signal', signal: `${id}-wait` }],
    });
    await page.route('**/jsonrpc', async (route) => {
      const body = JSON.parse(route.request().postData() ?? '{}') as {
        method?: string;
        id?: unknown;
      };
      if (body.method !== 'bureau.workflows.concurrency') return route.fallback();
      await route.fulfill({
        json: { jsonrpc: '2.0', id: body.id, result: { max: 4, running: 4 } },
      });
    });
    await page.goto(`/workflows/${id}/run`);
    await expect(area(page)).toHaveAttribute('data-state', 'ready');
    await expect(setup(page).getByTestId('run-setup-no-form')).toBeVisible();
    await expect(setup(page).getByText(COPY.nowAtLimit(4), { exact: true })).toBeVisible();
    await expect(footer(page).getByTestId('run-setup-summary')).toContainText(
      'when one of the 4 finishes',
    );
    await captureForDesignReview(page, {
      route: '/workflows/:workflow/run',
      state: '58i-no-input-and-58z-concurrency-limit',
      source: SOURCE,
    });
  });

  test('59a: an actual start at the execution cap appears on Runs as Scheduled', async ({
    page,
    request,
    pageErrors,
  }) => {
    const id = 'e2e-setup-queued-release';
    const running = new Map<string, string>();
    const blockingWorkflows = Array.from({ length: 4 }, (_, index) => `e2e-setup-slot-${index}`);
    try {
      for (const blocker of blockingWorkflows) {
        await createWaiting(request, blocker);
        const answer = await bureau(request, 'bureau.workflows.start', {
          id: blocker,
          input: { topic: 'hold an executing slot' },
        });
        expect(answer.fault, `start ${blocker}`).toBeUndefined();
        expect(answer.result).toHaveProperty('runId', expect.any(String));
        running.set(blocker, (answer.result as { runId: string }).runId);
      }
      await expect
        .poll(async () => {
          const answer = await bureau(request, 'bureau.workflows.concurrency', {});
          return answer.result;
        })
        .toEqual({ max: 4, running: 4 });
      await createReleaseSetup(request, id);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`/workflows/${id}/run`);
      await setup(page)
        .getByLabel(/^Branch/)
        .fill('main');
      await setup(page)
        .getByLabel(/^Since/)
        .fill('2026-10-23');
      await expect(footer(page).getByTestId('run-setup-summary')).toHaveText(
        'Runs once, when one of the 4 finishes, on main since Oct 23.',
      );
      const start = footer(page).getByRole('button', { name: COPY.startAction });
      await expect(start).toBeEnabled();
      await captureForDesignReview(page, {
        route: '/workflows/:workflow/run',
        state: '59a-four-executing-start-enabled',
        source: SOURCE,
      });

      expectEngineMissesForFileRuns(pageErrors);
      await start.click();
      await expect(page).toHaveURL(new RegExp(`/workflows/${id}/runs/[^/]+$`));
      const [run] = await listWorkflowRuns(request, id);
      if (run === undefined) throw new Error('Run Setup did not create a durable workflow run.');
      running.set(id, run.id);
      await page.goto(`/runs?workflow=${id}`);
      const row = page.locator(`li[data-run="${run.id}"]`);
      await expect(row).toHaveAttribute('data-status', 'Scheduled');
      await expect(row.getByRole('img', { name: 'Scheduled' })).toHaveAttribute(
        'data-cinder-status',
        'pending',
      );
      await expect(row).toContainText('waiting for a run slot');
      await captureForDesignReview(page, {
        route: '/runs',
        state: '59a-start-queued-for-a-slot',
        source: SOURCE,
      });

      const first = blockingWorkflows[0]!;
      await finish(request, first, running.get(first)!);
      running.delete(first);
      await expect
        .poll(async () => {
          const [workflowStatus, tasks] = await Promise.all([
            workflowRunStatus(request, run.id),
            bureau(request, 'bureau.tasks.list', { workflow: id }),
          ]);
          expect(tasks.fault, `listing the task for ${id}`).toBeUndefined();
          const task = (tasks.result as { tasks: Array<Record<string, unknown>> }).tasks.find(
            (candidate) => candidate['id'] === run.id,
          );
          return {
            workflowStatus,
            taskStatus: task?.['status'],
            awaitingSignal: task?.['workflow'],
          };
        })
        .toEqual({
          workflowStatus: 'running',
          taskStatus: 'working',
          awaitingSignal: expect.objectContaining({ awaitingSignal: `${id}-wait` }),
        });
      await expect(row).toHaveAttribute('data-status', 'Waiting for a signal');
      await expect(row).toContainText(`waiting for signal ${id}-wait`);
    } finally {
      for (const runId of running.values()) {
        const answer = await bureau(request, 'bureau.workflows.runs.cancel', { runId });
        expect(answer.fault, `cancel ${runId}`).toBeUndefined();
      }
    }
  });

  test('58q: keeps When and the footer while the workflow detail read fails', async ({
    page,
    request,
  }) => {
    const id = 'e2e-setup-detail-failure';
    await createReleaseSetup(request, id);
    await page.route('**/jsonrpc', async (route) => {
      const body = route.request().postDataJSON() as {
        id?: unknown;
        method?: string;
        params?: { id?: string };
      };
      if (body.method !== 'bureau.workflows.get' || body.params?.id !== id) return route.fallback();
      await route.fulfill({
        json: { jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'Down' } },
      });
    });
    await page.goto('/runs/new');
    await page.getByRole('combobox', { name: WORKFLOW_COPY.runPicker.fieldLabel }).selectOption(id);
    await page.getByRole('button', { name: WORKFLOW_COPY.runPicker.continue }).click();
    await expect(area(page)).toHaveAttribute('data-state', 'error');
    await expect(setup(page).getByTestId('run-setup-input-failed')).toBeVisible();
    await expect(
      setup(page).getByRole('heading', { level: 2, name: COPY.whenHeading }),
    ).toBeVisible();
    await expect(footer(page).getByRole('button', { name: COPY.startAction })).toBeDisabled();
    const jsonFallback = setup(page).getByRole('button', { name: COPY.inputFallback });
    await expect(jsonFallback).toBeVisible();
    await captureForDesignReview(page, {
      route: '/workflows/:workflow/run',
      state: '58q-input-schema-load-failed',
      source: SOURCE,
    });
    await jsonFallback.click();
    const editor = await jsonEditor(setup(page), COPY.jsonEditorLabel);
    await expect(editor).toBeVisible();
  });

  test('58u: preserves an invalid file trigger beside the disabled run setup', async ({
    page,
    request,
  }) => {
    const id = 'e2e-setup-invalid-trigger-file';
    await createWaiting(request, id);
    await Bun.write(
      await workflowFilePath(request, id),
      JSON.stringify({
        name: id,
        trigger: { kind: 'signal', name: `${id}-go` },
        steps: [{ kind: 'unsupported' }],
      }),
    );
    await expect
      .poll(async () => {
        const workflow = await readWorkflow(request, id);
        return workflow.state;
      })
      .toBe('invalid');
    await page.goto(`/workflows/${id}/run`);
    await expect(area(page)).toHaveAttribute('data-state', 'ready');
    await expect(setup(page).getByTestId('run-setup-unreadable')).toBeVisible();
    await expect(setup(page).getByTestId('run-setup-no-form')).toContainText(COPY.unreadableInput);
    await expect(setup(page).getByTestId('run-setup-trigger')).toContainText(`${id}-go`);
    await captureForDesignReview(page, {
      route: '/workflows/:workflow/run',
      state: '58u-invalid-file',
      source: SOURCE,
    });
  });

  test('57w: invalid JSON names the problem without dropping the schema form draft', async ({
    page,
    request,
  }) => {
    const id = 'e2e-setup-invalid-json';
    await createReleaseSetup(request, id);
    await page.goto(`/workflows/${id}/run`);
    await expect(setup(page).getByLabel(/^Branch/)).toHaveAttribute('placeholder', 'such as main');
    await setup(page)
      .getByLabel(/^Branch/)
      .fill('main');
    await setup(page).getByRole('button', { name: COPY.editAsJson }).click();
    await replaceJsonEditorText(
      await jsonEditor(setup(page), COPY.jsonEditorLabel),
      '{\n  "branch": "main"\n  "since": "2026-10-23"\n}',
    );
    await expect(setup(page).getByText('Invalid JSON', { exact: true })).toBeVisible();
    await expect(setup(page).getByRole('button', { name: /^Back to form/ })).toBeDisabled();
    await expect(footer(page).getByRole('button', { name: COPY.startAction })).toBeEnabled();
    await captureForDesignReview(page, {
      route: '/workflows/:workflow/run',
      state: '57w-raw-json-invalid',
      source: SOURCE,
    });
    expect(await listWorkflowRuns(request, id)).toEqual([]);
  });

  test('58w: carries the picker metadata into Run setup while the detail read is held', async ({
    page,
    request,
  }) => {
    const id = 'e2e-setup-held-detail';
    await createReleaseSetup(request, id);
    await page.goto('/runs/new');
    const workflow = page.getByRole('combobox', { name: WORKFLOW_COPY.runPicker.fieldLabel });
    await workflow.selectOption(id);
    const held = Promise.withResolvers<void>();
    await page.route('**/jsonrpc', async (route) => {
      const body = route.request().postDataJSON() as { method?: string; params?: { id?: string } };
      if (body.method !== 'bureau.workflows.get' || body.params?.id !== id) return route.fallback();
      await held.promise;
      await route.fallback();
    });
    try {
      await page.getByRole('button', { name: WORKFLOW_COPY.runPicker.continue }).click();
      const heading = setup(page).getByRole('heading', { level: 1 });
      await expect(heading).toHaveText(`Run Release notes ${id}`);
      await expect(setup(page).getByText('Collects merged changes into a draft.')).toBeVisible();
      await expect(setup(page).getByLabel(/^Branch/)).toHaveCount(0);
      await expect(footer(page).getByRole('button', { name: COPY.startAction })).toBeDisabled();
      await expect(
        setup(page).locator('.cinder-skeleton-group[data-cinder-variant="form"]'),
      ).toBeVisible();
      await captureForDesignReview(page, {
        route: '/workflows/:workflow/run',
        state: '58w-route-heading-with-loading-input',
        source: SOURCE,
      });
    } finally {
      held.resolve();
    }
    await expect(setup(page).getByLabel(/^Branch/)).toBeVisible();
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
    await expect(page).toHaveURL(/\/runs\/new$/);
    await page.getByRole('combobox', { name: WORKFLOW_COPY.runPicker.fieldLabel }).selectOption(id);
    await page.getByRole('button', { name: WORKFLOW_COPY.runPicker.continue }).click();
    await expect(page).toHaveURL(new RegExp(`/workflows/${id}/run$`));
    await expect(page.getByRole('heading', { level: 1, name: COPY.title(id) })).toBeVisible();
  });
});

test.describe('on a schedule at /workflows/:workflow/run', () => {
  test('S67: gives the named start text when the caller cannot create schedules', async ({
    page,
  }) => {
    const response = await page.request.get('/api/v1/principal');
    expect(response.ok()).toBe(true);
    const principal = (await response.json()) as { scopes: string[] };
    const withoutScheduling = {
      ...principal,
      scopes: principal.scopes.filter((scope) => scope !== 'schedules:write'),
    };
    await page.route('**/api/v1/principal', async (route) => {
      await route.fulfill({ json: withoutScheduling });
    });
    await page.route('**/jsonrpc', async (route) => {
      const call = route.request().postDataJSON() as { id: unknown; method?: string };
      if (call.method !== 'weft.system.principal') return route.fallback();
      await route.fulfill({ json: { jsonrpc: '2.0', id: call.id, result: withoutScheduling } });
    });

    await page.goto('/workflows/order-processing/run');
    await expect(area(page)).toHaveAttribute('data-state', 'ready');
    await expect(setup(page).getByText(COPY.nowOnlyDescription, { exact: true })).toBeVisible();
    await expect(setup(page).getByRole('radiogroup', { name: COPY.whenLabel })).toHaveCount(0);
    await expect(footer(page).getByRole('button', { name: COPY.startAction })).toBeEnabled();
    await captureForDesignReview(page, {
      route: '/workflows/:workflow/run',
      state: 'S67-only-now',
      source: SOURCE,
    });
  });

  test('S67: creates a schedule for a code-defined type in the chosen zone', async ({
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
    // The zone is a picker: its trigger opens a list with its own search field.
    await setup(page)
      .getByRole('combobox', { name: /^Time zone/ })
      .click();
    await page.getByPlaceholder('Search time zones').fill('Los Angeles');
    await page
      .getByRole('option', { name: /Los Angeles/ })
      .first()
      .click();
    await expect(footer(page).getByTestId('run-setup-summary')).toContainText(
      'every day at 3:00 AM Pacific time',
    );
    await captureForDesignReview(page, {
      route: '/workflows/:workflow/run',
      state: 'S67-on-a-schedule',
      source: SOURCE,
    });
    await footer(page).getByRole('button', { name: COPY.scheduleAction }).click();
    await expect(page).toHaveURL(/\/schedules\/[^/?]+$/);
    // The schedule is named by the Name field, which starts as the workflow's name in words.
    await expect(page.getByRole('heading', { level: 1, name: 'Order processing' })).toBeVisible();
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

  test('is offered for a file too, and says so in the heading', async ({ page, request }) => {
    const id = 'e2e-setup-file-schedule';
    await createWaiting(request, id);
    await page.goto(`/workflows/${id}/run`);
    await expect(area(page)).toHaveAttribute('data-state', 'ready');
    await setup(page)
      .getByRole('radio', { name: new RegExp(COPY.schedule) })
      .click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(COPY.scheduleVerb);
    await expect(setup(page).getByLabel('Name', { exact: true })).toBeVisible();
  });
});
