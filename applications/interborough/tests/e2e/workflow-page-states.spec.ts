/**
 * The workflow page (`/workflows/:workflow`) and its builder in the states the design review needs
 * that the sample world's showcase routes do not capture (COR-2431, board PageWorkflow and
 * PageWorkflowBuilder), at 1280 and 375 pixels, each under its own state name so the stress capture
 * of `responsive.spec.ts` never writes over it:
 *
 * - Release notes with a run parked on the signal `notes-approved` since today (rows 63n and 63o),
 *   and with no run at all (rows 13b and 63c), by route stubbing of `bureau.workflows.runs.list`.
 * - Release notes' "⋯" menu, open, with Pause and what pausing does (row 63m).
 * - Triage inbox as the board draws it, started by a signal and also by the paused Inbox triage
 *   schedule that runs it from outside its file (rows 62q, 62r), its menu open (62q), its delete
 *   dialog (62s) and that dialog with the schedule checked (63l), by route stubbing of the file and
 *   its schedules; and its Runs tab as the sample world holds it (63p).
 * - A workflow that does not exist (63h), and Edit on Order refund, whose file can't load, open on
 *   its JSON tab (63g, 66f).
 *
 * The stubbed answers are `workflow-page-states-stubs.ts`, which a unit test checks against the
 * client's schemas. Not run on this host (the browser suites run on GitHub, `main.yml`).
 */
import type { Locator, Page, Route } from '@playwright/test';

import { SAMPLE_NOW, SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { readSampleWorldRecords } from '../../fixtures/sample-world-records.ts';
import { WORKFLOW_COPY } from '../../src/app/copy/workflows.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';
import { jsonEditor, replaceJsonEditorText } from './json-editor-support.ts';
import {
  asOutsideSchedule,
  asSignalStarted,
  listWithSignalStarted,
  MORNING_BRIEFING_TEXT,
  REFUSED_LINE,
  refusedValidation,
  unwritableAnswer,
  waitingSignalRun,
  withNoRuns,
  withRunFirst,
} from './workflow-page-states-stubs.ts';
import { openJsonTab, openTab } from './workflow-support.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'workflow-page-states.spec.ts';
const WIDTHS = [1280, 375] as const;
const MENU = WORKFLOW_COPY.page.menu;
const DELETE = WORKFLOW_COPY.deleteDialog;
const BUILDER = WORKFLOW_COPY.builder;

type JsonRecord = Record<string, unknown>;

const detail = (page: Page) => page.locator('[data-page="workflow-detail"]');

/** Answers the Bureau operation `method` with its own answer rewritten by `rewrite`; others pass through. */
async function rewriteOperation(
  page: Page,
  method: string,
  rewrite: (result: JsonRecord, params: JsonRecord) => JsonRecord,
): Promise<void> {
  await page.route('**/bureau/jsonrpc', async (route: Route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as {
      method?: string;
      params?: JsonRecord;
    };
    if (body.method !== method) {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const answer = (await response.json()) as { result?: JsonRecord };
    if (answer.result === undefined) {
      await route.fulfill({ response });
      return;
    }
    await route.fulfill({
      response,
      json: { ...answer, result: rewrite(answer.result, body.params ?? {}) },
    });
  });
}

/** Opens `path` at `width` on the sample clock and waits until the workflow's page is drawn. */
async function openWorkflow(page: Page, path: string, width: number): Promise<void> {
  await page.clock.setFixedTime(SAMPLE_NOW);
  await page.setViewportSize({ width, height: 900 });
  await page.goto(path);
  await expect(page.locator('[data-view="workflows"]')).toHaveAttribute('data-state', 'ready');
  await expect(
    detail(page)
      .locator('[data-testid="workflow-overview"], [data-testid="workflow-recent-runs"]')
      .first(),
  ).toBeAttached();
}

/** Triage inbox as the board draws it: started by a signal, and run by an outside, paused schedule. */
async function triageAsDrawn(page: Page, id: string): Promise<void> {
  await rewriteOperation(page, 'bureau.workflows.get', (file, params) =>
    params['id'] === id ? asSignalStarted(file) : file,
  );
  await rewriteOperation(page, 'bureau.workflows.list', (answer) =>
    listWithSignalStarted(answer, id),
  );
  await page.route(
    (url) => url.pathname.endsWith('/schedules') && url.searchParams.get('workflowType') === id,
    async (route: Route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        json: asOutsideSchedule((await response.json()) as JsonRecord),
      });
    },
  );
}

for (const width of WIDTHS) {
  test.describe(`at ${String(width)} pixels`, () => {
    test('Release notes with a run waiting on a signal: Runs 2, the header names the signal, the row reads Waiting (63n, 63o)', async ({
      page,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      const id = world.workflows.releaseNotes;
      await rewriteOperation(page, 'bureau.workflows.runs.list', (answer) => {
        const runs = Array.isArray(answer['runs']) ? (answer['runs'] as JsonRecord[]) : [];
        const recorded = runs[0]?.['workflowVersion'];
        const version = typeof recorded === 'string' ? recorded : 'sha256:sample';
        return withRunFirst(answer, waitingSignalRun(id, version));
      });
      await openWorkflow(page, `/workflows/${encodeURIComponent(id)}?tab=runs`, width);

      const line = detail(page).getByTestId('workflow-line-last-run');
      await expect(line).toContainText('today, 10:05 AM');
      await expect(line).toContainText('Waiting for the signal');
      await expect(line.locator('code', { hasText: 'notes-approved' })).toBeVisible();
      const runs = detail(page).getByTestId('workflow-recent-runs');
      await expect(runs).toContainText(
        'Workflow, You, waiting for the signal notes-approved, step 4 of 4',
      );
      await expect(runs).toContainText('Waiting');
      await captureForDesignReview(page, {
        route: '/workflows/:workflow',
        tab: 'runs',
        state: 'a run waiting on a signal',
        source: SOURCE,
      });
    });

    test('Release notes that has never run: the compact empty state with a neutral disc (13b, 63c)', async ({
      page,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      await rewriteOperation(page, 'bureau.workflows.runs.list', withNoRuns);
      await openWorkflow(
        page,
        `/workflows/${encodeURIComponent(world.workflows.releaseNotes)}?tab=runs`,
        width,
      );
      const empty = detail(page).locator('.cinder-empty-state[data-cinder-size="compact"]');
      await expect(empty).toContainText(WORKFLOW_COPY.page.runs.emptyTitle);
      await captureForDesignReview(page, {
        route: '/workflows/:workflow',
        tab: 'runs',
        state: 'no runs yet',
        source: SOURCE,
      });
    });

    test('Release notes’ menu, open: Pause with what pausing does under it (63m)', async ({
      page,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      await openWorkflow(
        page,
        `/workflows/${encodeURIComponent(world.workflows.releaseNotes)}`,
        width,
      );
      await detail(page).getByRole('button', { name: MENU.label }).click();
      await expect(page.getByRole('menuitem', { name: MENU.pause })).toHaveAccessibleDescription(
        MENU.pauseDescription,
      );
      await captureForDesignReview(page, {
        route: '/workflows/:workflow',
        state: 'more menu, active',
        source: SOURCE,
      });
    });

    test('Triage inbox as drawn: Paused, Resume, the signal and the outside schedule, and its menu (62q, 62r)', async ({
      page,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      const id = world.workflows.triageInbox;
      await triageAsDrawn(page, id);
      await openWorkflow(page, `/workflows/${encodeURIComponent(id)}`, width);

      await expect(detail(page).getByTestId('workflow-state')).toContainText('Paused');
      await expect(
        detail(page).getByRole('button', { name: WORKFLOW_COPY.resumeAction }),
      ).toBeVisible();
      await expect(detail(page).getByTestId('workflow-line-schedule')).toContainText('paused');
      await captureForDesignReview(page, {
        route: '/workflows/:workflow',
        state: 'paused, started by a signal and a schedule',
        source: SOURCE,
      });
      await detail(page).getByRole('button', { name: MENU.label }).click();
      await expect(page.getByRole('menuitem')).toHaveCount(2);
      await captureForDesignReview(page, {
        route: '/workflows/:workflow',
        state: 'more menu, paused',
        source: SOURCE,
      });
    });

    test('Triage inbox’s delete dialog, unchecked and then with the schedule checked (62s, 63l)', async ({
      page,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      const id = world.workflows.triageInbox;
      await triageAsDrawn(page, id);
      await openWorkflow(page, `/workflows/${encodeURIComponent(id)}`, width);
      await detail(page).getByRole('button', { name: MENU.label }).click();
      await page.getByRole('menuitem', { name: MENU.delete }).click();

      const dialog = page.getByRole('dialog');
      await expect(dialog).toContainText(DELETE.alsoDeleteSchedule('Inbox triage'));
      await expect(dialog.getByRole('button', { name: DELETE.confirm, exact: true })).toBeVisible();
      await captureForDesignReview(page, {
        route: '/workflows/:workflow',
        state: 'delete dialog',
        source: SOURCE,
      });
      await dialog.getByRole('checkbox').check();
      await expect(dialog.getByRole('button', { name: DELETE.confirmWithSchedule })).toBeVisible();
      await captureForDesignReview(page, {
        route: '/workflows/:workflow',
        state: 'delete dialog, schedule checked',
        source: SOURCE,
      });
    });

    test('Triage inbox’s Runs tab as the sample world holds it (63p)', async ({ page }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      await openWorkflow(
        page,
        `/workflows/${encodeURIComponent(world.workflows.triageInbox)}?tab=runs`,
        width,
      );
      await expect(detail(page).getByTestId('workflow-recent-runs')).toBeVisible();
      await captureForDesignReview(page, {
        route: '/workflows/:workflow',
        tab: 'runs',
        state: 'paused, with history',
        source: SOURCE,
      });
    });

    test('a workflow that does not exist: neutral, Back to workflows, breadcrumb Workflows (63h)', async ({
      page,
    }) => {
      await page.clock.setFixedTime(SAMPLE_NOW);
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/workflows/does-not-exist');
      await expect(
        page.getByRole('heading', { level: 1, name: WORKFLOW_COPY.page.notFound.title }),
      ).toBeVisible();
      await expect(
        page.getByRole('link', { name: WORKFLOW_COPY.page.notFound.back }),
      ).toBeVisible();
      await captureForDesignReview(page, {
        route: '/workflows/:workflow',
        state: 'workflow not found, neutral',
        source: SOURCE,
      });
    });

    test('Edit on a file that can’t load opens on the JSON tab, Invalid JSON, Builder off (63g, 66f)', async ({
      page,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      await page.clock.setFixedTime(SAMPLE_NOW);
      await page.setViewportSize({ width, height: 900 });
      await page.goto(
        `/workflows/${encodeURIComponent(world.workflows.orderRefund)}/edit?tab=json`,
      );
      await expect(page.locator('.cinder-json-editor__status')).toContainText(
        WORKFLOW_COPY.builder.json.invalid,
      );
      // The footer names the line, which is the Builder tab's reason while it is off.
      await expect(page.getByTestId('workflow-builder-summary')).toContainText(/^Fix line \d+/);
      await captureForDesignReview(page, {
        route: '/workflows/:workflow/edit',
        tab: 'json',
        state: 'a file that can’t load',
        source: SOURCE,
      });
    });

    // COR-2432: the builder's states (board PageWorkflowBuilder). Below 640 pixels the builder is
    // read-only and says "Open on a larger screen" (row 05n), so these are drawn on a desktop.
    test.describe('the builder', () => {
      test.skip(width !== 1280, 'The builder is read-only below 640 pixels (row 05n).');

      test('New workflow On a schedule, on its JSON tab: every field the builder writes (65d)', async ({
        page,
      }) => {
        const root = await openBuilder(page, '/workflows/new', width);
        await root.getByRole('radio', { name: BUILDER.triggers.schedule }).click();
        await expect(root.getByTestId('schedule-when')).toBeVisible();
        await captureForDesignReview(page, {
          route: '/workflows/new',
          state: 'on a schedule, the When block',
          source: SOURCE,
        });
        await openJsonTab(root);
        const editor = await jsonEditor(root, WORKFLOW_COPY.creator.textLabel);
        await expect(editor).toContainText('"timezone"');
        await expect(editor).toContainText('"catchUp"');
        await captureForDesignReview(page, {
          route: '/workflows/new',
          tab: 'json',
          state: 'a schedule, every field',
          source: SOURCE,
        });
      });

      test('New workflow with JSON that does not parse: Invalid JSON and Fix line N (65f)', async ({
        page,
      }) => {
        const root = await openBuilder(page, '/workflows/new', width);
        await openJsonTab(root);
        const editor = await jsonEditor(root, WORKFLOW_COPY.creator.textLabel);
        await replaceJsonEditorText(editor, MORNING_BRIEFING_TEXT.replace('"title": ', '"title" '));
        await expect(root.locator('.cinder-json-editor__status')).toContainText(
          WORKFLOW_COPY.builder.json.invalid,
        );
        await captureForDesignReview(page, {
          route: '/workflows/new',
          tab: 'json',
          state: 'invalid JSON',
          source: SOURCE,
        });
      });

      test('New workflow the Bureau refuses: the line is marked and Create goes there (65z)', async ({
        page,
      }) => {
        await page.route('**/bureau/jsonrpc', async (route: Route) => {
          const body = JSON.parse(route.request().postData() ?? '{}') as {
            method?: string;
            id?: unknown;
          };
          if (body.method !== 'bureau.workflows.validate') {
            await route.fallback();
            return;
          }
          await route.fulfill({
            json: { jsonrpc: '2.0', id: body.id, result: refusedValidation() },
          });
        });
        const root = await openBuilder(page, '/workflows/new', width);
        await openJsonTab(root);
        const editor = await jsonEditor(root, WORKFLOW_COPY.creator.textLabel);
        await replaceJsonEditorText(editor, MORNING_BRIEFING_TEXT);
        await root.getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }).click();
        await expect(root.getByTestId('workflow-builder-summary')).toHaveText(
          WORKFLOW_COPY.builder.json.fixLine(REFUSED_LINE),
        );
        await captureForDesignReview(page, {
          route: '/workflows/new',
          tab: 'json',
          state: 'valid JSON, not a valid workflow',
          source: SOURCE,
        });
      });

      test('a step the builder can’t draw is a read-only card, and the footer says so (66a, 66b)', async ({
        page,
      }) => {
        const root = await openBuilder(page, '/workflows/new', width);
        await openJsonTab(root);
        const editor = await jsonEditor(root, WORKFLOW_COPY.creator.textLabel);
        await replaceJsonEditorText(editor, MORNING_BRIEFING_TEXT);
        await openTab(root, BUILDER.builderTab);
        await expect(root.getByTestId('workflow-step-other')).toContainText(BUILDER.otherStepLine);
        await expect(root.getByTestId('workflow-builder-summary')).toContainText(
          BUILDER.readBack.other,
        );
        await captureForDesignReview(page, {
          route: '/workflows/new',
          state: 'a step the builder doesn’t model',
          source: SOURCE,
        });
      });

      test('Create that the host cannot write: the error at the action, nothing saved (65n)', async ({
        page,
      }) => {
        await answerUnwritable(page, 'bureau.workflows.create', 'morning-briefing.json');
        const root = await openBuilder(page, '/workflows/new', width);
        await openJsonTab(root);
        const editor = await jsonEditor(root, WORKFLOW_COPY.creator.textLabel);
        await replaceJsonEditorText(
          editor,
          // Step 3 a wait the Bureau knows, so the write itself is what fails.
          MORNING_BRIEFING_TEXT.replace('"fan-out"', '"sleep"').replace(
            '"over": "teams"',
            '"duration": "15m"',
          ),
        );
        await root.getByRole('button', { name: WORKFLOW_COPY.creator.saveAction }).click();
        await expect(root).toContainText(WORKFLOW_COPY.creator.nothingSaved);
        await captureForDesignReview(page, {
          route: '/workflows/new',
          state: 'create failed',
          source: SOURCE,
        });
      });

      test('Edit Release notes: its JSON tab, a save the host cannot write, and Cancel with changes (65j, 65w, 66h)', async ({
        page,
      }) => {
        const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
        await answerUnwritable(page, 'bureau.workflows.update', 'release-notes.json');
        const path = `/workflows/${encodeURIComponent(world.workflows.releaseNotes)}/edit`;
        const root = await openBuilder(page, `${path}?tab=json`, width);
        await openJsonTab(root);
        await captureForDesignReview(page, {
          route: '/workflows/:workflow/edit',
          tab: 'json',
          state: 'a file-defined schedule',
          source: SOURCE,
        });

        await openTab(root, BUILDER.builderTab);
        const title = root.getByLabel(BUILDER.titleLabel, { exact: true });
        await title.fill('Release notes, weekly');
        await root.getByRole('button', { name: WORKFLOW_COPY.editor.saveAction }).click();
        await expect(root).toContainText(WORKFLOW_COPY.creator.nothingSaved);
        await captureForDesignReview(page, {
          route: '/workflows/:workflow/edit',
          state: 'save failed',
          source: SOURCE,
        });

        await root.getByRole('button', { name: WORKFLOW_COPY.editor.cancelAction }).click();
        await expect(page.getByRole('dialog', { name: BUILDER.discard.title })).toBeVisible();
        await captureForDesignReview(page, {
          route: '/workflows/:workflow/edit',
          state: 'cancel with unsaved changes',
          source: SOURCE,
        });
      });
    });
  });
}

/** Opens the builder at `path` on the sample clock at `width`, and returns its page. */
async function openBuilder(page: Page, path: string, width: number): Promise<Locator> {
  await page.clock.setFixedTime(SAMPLE_NOW);
  await page.setViewportSize({ width, height: 900 });
  await page.goto(path);
  const root = page.locator('[data-page="workflow-creator"], [data-page="workflow-editor"]');
  await expect(root.getByTestId('workflow-builder')).toBeVisible();
  return root;
}

/** Answers the write `method` with the refusal of a file the host could not put on disk. */
async function answerUnwritable(page: Page, method: string, file: string): Promise<void> {
  await page.route('**/bureau/jsonrpc', async (route: Route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as {
      method?: string;
      id?: unknown;
    };
    if (body.method !== method) {
      await route.fallback();
      return;
    }
    await route.fulfill({ json: unwritableAnswer(body.id, file) });
  });
}
