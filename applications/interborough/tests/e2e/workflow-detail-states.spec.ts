/** Captioned workflow detail, history, and run-list states from PageWorkflow (COR-2431). */
import type { Page, Route } from '@playwright/test';

import { SAMPLE_NOW, SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { readSampleWorldRecords } from '../../fixtures/sample-world-records.ts';
import { TASK_COPY } from '../../src/app/copy/tasks.ts';
import { WORKFLOW_COPY } from '../../src/app/copy/workflows.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';
import {
  asOutsideSchedule,
  asRefundHistory,
  asRefundOutsideSchedule,
  asSignalStarted,
  listWithSignalStarted,
  REFUND_SIGNAL,
  REFUND_VERSIONS,
  waitingSignalRun,
  withNoRuns,
  withRunFirst,
} from './workflow-detail-states-stubs.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'workflow-detail-states.spec.ts';
const WIDTHS = [1280, 375] as const;
const MENU = WORKFLOW_COPY.page.menu;
const DELETE = WORKFLOW_COPY.deleteDialog;

type JsonRecord = Record<string, unknown>;

const detail = (page: Page) => page.locator('[data-page="workflow-detail"]');

/** Answers the Bureau operation `method` with its own answer rewritten by `rewrite`; others pass through. */
async function rewriteOperation(
  page: Page,
  method: string,
  rewrite: (result: JsonRecord, params: JsonRecord) => JsonRecord,
): Promise<void> {
  await page.route('**/jsonrpc', async (route: Route) => {
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
  test.describe(`workflow detail design states on /workflows/:workflow at ${String(width)} pixels`, () => {
    test('Release notes overview and the current file (62b, 62c, 62k)', async ({ page }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      const path = `/workflows/${encodeURIComponent(world.workflows.releaseNotes)}`;
      await openWorkflow(page, path, width);
      const root = detail(page);
      await expect(root.getByRole('heading', { name: /Release notes/, level: 1 })).toBeVisible();
      await expect(root.getByTestId('workflow-identifier')).toHaveText('release-notes');
      await expect(root.getByTestId('workflow-state')).toHaveCount(0);
      const starts = root.getByTestId('workflow-line-starts');
      await expect(starts).toContainText('Starts every Friday at 11:00 AM');
      await expect(starts).toContainText('Runs as Assistant');
      await expect(root.getByTestId('workflow-line-last-run')).toContainText(/failed\s+at step 2/i);
      await expect(root.getByTestId('workflow-line-schedule')).toContainText(
        'Release notes digest',
      );
      await captureForDesignReview(page, {
        route: '/workflows/:workflow',
        state: 'release notes overview',
        source: SOURCE,
      });

      await page.goto(`${path}?tab=code`);
      const code = root.getByTestId('workflow-file-source');
      await expect(code).toContainText('0 11 * * 5');
      await expect(code).toContainText('America/Chicago');
      await expect(code).toContainText('notes-approved');
      await captureForDesignReview(page, {
        route: '/workflows/:workflow',
        tab: 'code',
        state: 'release notes file',
        source: SOURCE,
      });
    });

    test('Release notes failed run and the saved version history (62n, 62o, 62p)', async ({
      page,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      const path = `/workflows/${encodeURIComponent(world.workflows.releaseNotes)}`;
      await openWorkflow(page, `${path}?tab=runs`, width);
      const runs = detail(page).getByTestId('workflow-recent-runs');
      await expect(runs).toContainText(/failed at step 2 of 4/i);
      await expect(runs).toContainText(/GitHub didn.t answer/i);
      await expect(runs).toContainText('Release notes digest');
      await captureForDesignReview(page, {
        route: '/workflows/:workflow',
        tab: 'runs',
        state: 'release notes failed run',
        source: SOURCE,
      });

      await page.goto(`${path}?tab=history`);
      const versions = detail(page).getByTestId('workflow-revision-title');
      const expected = ['1.3.0', '1.2.0', '1.1.0'];
      for (const version of expected) {
        await expect(versions.filter({ hasText: version })).toBeVisible();
      }
      await expect(detail(page).getByTestId('workflow-revisions-footnote')).toContainText(
        'Scheduled and chat runs always start on the current version.',
      );
      await captureForDesignReview(page, {
        route: '/workflows/:workflow',
        tab: 'history',
        state: 'release notes saved versions',
        source: SOURCE,
      });
    });

    test('Release notes with a run waiting on a signal: Runs 2, the header names the signal, the row reads Waiting (63n, 63o)', async ({
      page,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      const id = world.workflows.releaseNotes;
      await rewriteOperation(page, 'bureau.workflows.runs.list', (answer, params) => {
        if (params['workflow'] !== id) return answer;
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
      await expect(runs).toContainText('waiting for the signal notes-approved');
      await expect(runs).toContainText('step 4 of 4');
      await expect(runs).toContainText('Waiting');
      await captureForDesignReview(page, {
        route: '/workflows/:workflow',
        tab: 'runs',
        state: 'a run waiting on a signal',
        source: SOURCE,
      });

      // The segment a parked run counts under, shown only while one is (row 63o): a bar that
      // folds its segments into one select is opened, so the capture shows it either way.
      const signalSegment = TASK_COPY.list.segments.signal;
      const folded = runs.getByRole('combobox', { name: TASK_COPY.statusLabel });
      if (await folded.isVisible()) {
        await folded.click();
        await expect(page.getByRole('option', { name: new RegExp(signalSegment) })).toBeVisible();
      } else {
        await expect(runs.getByRole('radio', { name: new RegExp(signalSegment) })).toBeVisible();
      }
      await captureForDesignReview(page, {
        route: '/workflows/:workflow',
        tab: 'runs',
        state: 'a run waiting on a signal, its segment',
        source: SOURCE,
      });
    });

    test('Release notes that has never run: the shared first-use empty state (13b, 63c)', async ({
      page,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      await rewriteOperation(page, 'bureau.workflows.runs.list', (answer, params) =>
        params['workflow'] === world.workflows.releaseNotes ? withNoRuns(answer) : answer,
      );
      await openWorkflow(
        page,
        `/workflows/${encodeURIComponent(world.workflows.releaseNotes)}?tab=runs`,
        width,
      );
      const empty = detail(page).getByRole('group', { name: WORKFLOW_COPY.page.runs.emptyTitle });
      await expect(empty).toBeVisible();
      await expect(empty).toHaveAttribute('data-cinder-kind', 'first-use');
      await expect(
        detail(page).getByLabel(WORKFLOW_COPY.page.runs.filtersLabel, { exact: true }),
      ).toHaveCount(0);
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

    test('Order refund’s Code tab: the banner of a file that can’t load, with Edit as JSON (63g)', async ({
      page,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      // The Code tab mounts neither the Overview nor the Runs list that `openWorkflow` waits for.
      await page.clock.setFixedTime(SAMPLE_NOW);
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/workflows/${encodeURIComponent(world.workflows.orderRefund)}?tab=code`);
      await expect(detail(page).getByTestId('workflow-code')).toBeVisible();
      const editAsJson = detail(page).getByRole('button', {
        name: WORKFLOW_COPY.page.problem.editAsJson,
      });
      await expect(editAsJson).toBeVisible();
      await captureForDesignReview(page, {
        route: '/workflows/:workflow',
        tab: 'code',
        state: 'a file that can’t load, Edit as JSON',
        source: SOURCE,
      });
      await editAsJson.click();
      await expect(page).toHaveURL(/\/edit\?tab=json$/);
      await page.goBack();
      await detail(page).getByRole('link', { name: WORKFLOW_COPY.editAction }).click();
      await expect(page).toHaveURL(/\/edit\?tab=json$/);
    });

    test('Order refund as row 62v draws it: started by a signal, also by the Weekly refund audit schedule, History 4 (62v)', async ({
      page,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      const id = world.workflows.orderRefund;
      await rewriteOperation(page, 'bureau.workflows.history', (answer, params) =>
        params['id'] === id ? asRefundHistory(answer) : answer,
      );
      await rewriteOperation(page, 'bureau.workflows.revisions', (answer, params) =>
        params['id'] === id ? { ...answer, savedVersionCount: REFUND_VERSIONS } : answer,
      );
      await page.route(
        (url) => url.pathname.endsWith('/schedules') && url.searchParams.get('workflowType') === id,
        async (route: Route) => {
          const response = await route.fetch();
          await route.fulfill({
            response,
            json: asRefundOutsideSchedule((await response.json()) as JsonRecord),
          });
        },
      );
      await openWorkflow(page, `/workflows/${encodeURIComponent(id)}`, width);
      await expect(detail(page).getByTestId('workflow-state')).toHaveText("Can't load");
      await expect(
        detail(page).getByRole('button', { name: WORKFLOW_COPY.page.startAction }),
      ).toBeDisabled();
      const starts = detail(page).getByTestId('workflow-line-starts');
      await expect(starts).toContainText('Starts when a signal arrives');
      await expect(starts.locator('code', { hasText: REFUND_SIGNAL })).toBeVisible();
      await expect(detail(page).getByTestId('workflow-line-schedule')).toContainText(
        'Also started by the Weekly refund audit schedule',
      );
      // A phone folds the tabs into one select, so the count is read where they are tabs.
      if (width === 1280) {
        await expect(
          detail(page).getByRole('tab', {
            name: new RegExp(`History\\s*${String(REFUND_VERSIONS)}`),
          }),
        ).toBeVisible();
      }
      await captureForDesignReview(page, {
        route: '/workflows/:workflow',
        state: 'a file that can’t load, as row 62v draws it',
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
        page
          .getByRole('group', { name: WORKFLOW_COPY.page.notFound.title, exact: true })
          .getByRole('link', { name: 'Back to Workflows', exact: true }),
      ).toBeVisible();
      await captureForDesignReview(page, {
        route: '/workflows/:workflow',
        state: 'workflow not found, neutral',
        source: SOURCE,
      });
    });
  });
}
