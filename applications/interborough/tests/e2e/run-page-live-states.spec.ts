/**
 * The run page (`/runs/:run`) in the captioned states the sample world does not hold (COR-2424,
 * design rows 54l, 54f, 56g and 06b), captured for the design review on a desktop and a phone. Each
 * state is the sample world's own run with the host's answers rewritten by route stubbing, the way
 * `runs-states.spec.ts` builds its `row states` variant: the failed Release notes run answers as a
 * run still going at step 2 of 4 (54l) and as one parked on the signal `notes-approved` (56g), the
 * finished chat run answers as a run that is still working, with its message bar docked (06b), and
 * the finished chat run itself holds Run again because no provider is connected (54f).
 *
 * Not run on this host (the browser suites run on GitHub, `main.yml`).
 */
import type { Page, Route } from '@playwright/test';

import {
  SAMPLE_NOW,
  SAMPLE_NOW_MILLISECONDS,
  SAMPLE_TIME_ZONE,
} from '../../fixtures/sample-now.ts';
import { readSampleWorldRecords } from '../../fixtures/sample-world-records.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'run-page-live-states.spec.ts';
const WIDTHS = [1280, 375] as const;

type JsonRecord = Record<string, unknown>;

/** Answers the Bureau operation `method` with its own answer rewritten by `rewrite`; others pass through. */
async function rewriteOperation(
  page: Page,
  method: string,
  rewrite: (result: JsonRecord) => JsonRecord,
): Promise<void> {
  await page.route('**/bureau/jsonrpc', async (route: Route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { method?: string };
    if (body.method !== method) {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const answer = (await response.json()) as { result?: JsonRecord };
    await route.fulfill({
      response,
      json: { ...answer, result: rewrite(answer.result ?? {}) },
    });
  });
}

/**
 * Makes the sample world's failed Release notes run answer as a run still going: the engine says
 * `running` since `startedMilliseconds` before the sample clock, the Bureau's record agrees, and the
 * history ends without its terminal event.
 */
async function answerAsRunningInstance(
  page: Page,
  runId: string,
  startedMilliseconds: number,
  waitingForSignals: readonly string[],
): Promise<void> {
  const startedAt = SAMPLE_NOW_MILLISECONDS - startedMilliseconds;
  await page.route(new RegExp(`/workflows/${runId}(\\?.*)?$`), async (route: Route) => {
    const response = await route.fetch();
    const state = (await response.json()) as JsonRecord;
    delete state['error'];
    delete state['errorStack'];
    delete state['failureCategory'];
    delete state['result'];
    await route.fulfill({
      response,
      json: {
        ...state,
        status: 'running',
        createdAt: startedAt,
        updatedAt: SAMPLE_NOW_MILLISECONDS - 1000,
        ...(waitingForSignals.length === 0 ? {} : { waitingForSignals }),
      },
    });
  });
  await rewriteOperation(page, 'bureau.workflows.runs.get', (record) => ({
    ...record,
    status: 'running',
    error: null,
    finishReason: null,
    createdAt: new Date(startedAt).toISOString(),
    updatedAt: new Date(SAMPLE_NOW_MILLISECONDS - 1000).toISOString(),
  }));
  await rewriteOperation(page, 'bureau.workflows.runs.history', (history) => ({
    ...history,
    events: ((history['events'] as JsonRecord[] | undefined) ?? []).filter(
      (event) => event['type'] !== 'file-workflow:run-terminal',
    ),
  }));
}

/** Opens `path` at `width` and waits until the run's header says its status. */
async function openRun(page: Page, path: string, width: number): Promise<void> {
  await page.clock.setFixedTime(SAMPLE_NOW);
  await page.setViewportSize({ width, height: 900 });
  await page.goto(path);
  await expect(page.locator('[data-run-header] [data-status-word]')).toBeVisible();
}

for (const width of WIDTHS) {
  test.describe(`at ${String(width)} pixels`, () => {
    test('a Release notes run still going says when it started and its step, and offers no Run again (54l)', async ({
      page,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      await answerAsRunningInstance(page, world.runs.failed, 40_000, []);
      await openRun(page, `/runs/${encodeURIComponent(world.runs.failed)}`, width);

      const header = page.locator('[data-run-header]');
      await expect(header).toContainText(/Running\s*, Started 40 s ago, step 2 of 4/);
      await expect(header.getByRole('link', { name: 'Run again' })).toHaveCount(0);
      await expect(header.getByRole('button', { name: 'Run again' })).toHaveCount(0);
      await captureForDesignReview(page, {
        route: '/runs/:run',
        state: 'live instance',
        source: SOURCE,
      });
    });

    test('a run parked on a signal reads Waiting, and its header offers Cancel run (56g)', async ({
      page,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      await answerAsRunningInstance(page, world.runs.failed, 56 * 60_000, ['notes-approved']);
      await openRun(page, `/runs/${encodeURIComponent(world.runs.failed)}`, width);

      const header = page.locator('[data-run-header]');
      await expect(header).toContainText('Waiting');
      await expect(header).toContainText('waiting for signal');
      await expect(header).toContainText('notes-approved');
      await expect(header.getByRole('button', { name: 'Cancel run' })).toBeVisible();
      await expect(page.locator('[data-section="waiting"]')).toHaveCount(0);
      await captureForDesignReview(page, {
        route: '/runs/:run',
        state: 'waiting on a signal',
        source: SOURCE,
      });
    });

    test('a chat run still going shows how long it has run and docks its message bar (06b)', async ({
      page,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      await rewriteOperation(page, 'bureau.tasks.get', (task) => ({
        ...task,
        status: 'working',
        createdAt: new Date(SAMPLE_NOW_MILLISECONDS - 12_000).toISOString(),
        updatedAt: new Date(SAMPLE_NOW_MILLISECONDS - 1000).toISOString(),
      }));
      await openRun(page, `/runs/${encodeURIComponent(world.runs.done)}`, width);

      await expect(page.locator('[data-run-header]')).toContainText(/12 s so far/);
      await expect(page.getByTestId('run-send-message')).toBeVisible();
      await captureForDesignReview(page, {
        route: '/runs/:run',
        state: 'live chat run',
        source: SOURCE,
      });
    });

    test('a finished chat run holds Run again with a link to connect a provider beneath it (54f)', async ({
      page,
    }) => {
      const world = await readSampleWorldRecords(E2E_SHOWCASE_URL);
      await openRun(page, `/runs/${encodeURIComponent(world.runs.done)}`, width);

      const again = page.getByRole('button', { name: 'Run again' });
      await expect(again).toHaveAttribute('aria-disabled', 'true');
      const connect = page.getByRole('link', { name: 'Connect a provider' });
      await expect(connect).toHaveAttribute('href', '/settings/models');
      await expect(again).toHaveAttribute(
        'aria-describedby',
        (await connect.getAttribute('id')) ?? '',
      );
      // Beneath the actions, in the header's caption, never beside or above them (54f, 54z).
      const [button, link] = await Promise.all([again.boundingBox(), connect.boundingBox()]);
      expect(link!.y).toBeGreaterThanOrEqual(button!.y + button!.height - 1);
      await captureForDesignReview(page, {
        route: '/runs/:run',
        state: 'run again held, no provider',
        source: SOURCE,
      });
    });
  });
}
