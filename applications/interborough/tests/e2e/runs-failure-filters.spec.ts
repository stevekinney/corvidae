/**
 * The Runs list's Retrying and Failed at step filters (`/runs`, COR-2535) on the sample world at
 * the browser's sample clock (Monday, Nov 2, 10:46 AM Central time). The Bureau lists the runs and
 * applies the two filters; the sample world holds no run that failed at a step or is retrying one,
 * so the spec adds three the Bureau would list in a busier world (one that failed at `charge-card`,
 * one that failed at `model`, one on its third try of `charge-card`) to the real answer, and lists
 * each of them only when the request carries the filter that matches it. What the page asks of
 * `bureau.tasks.list` is read from the request, not from what comes back: a list that narrowed
 * itself in the browser would pass on the rows alone.
 */
import type { Page } from '@playwright/test';

import { SAMPLE_NOW, SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { TASK_COPY } from '../../src/app/copy/tasks.ts';
import { isBureauCall } from './bureau-answer-support.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'runs-failure-filters.spec.ts';

type ListRequest = Record<string, unknown>;

/** A failed run, as `bureau.tasks.list` answers it, with the step it failed at. */
function failedRun(id: string, createdAt: string, step: string) {
  return {
    id,
    contextId: id,
    agentName: 'tool-runner',
    owner: 'anonymous:local',
    actor: null,
    kind: 'chat',
    origin: { kind: 'api' },
    status: 'failed',
    finishReason: 'error',
    statusMessage: `${step} did not answer`,
    createdAt,
    updatedAt: createdAt,
    cleanup: null,
    openWaits: [],
    failure: {
      step: { index: 1, label: step },
      errorCode: 'tool-failed',
      errorKind: 'tool',
      toolCall: { name: step, callId: `${id}-call` },
    },
    retrying: null,
  };
}

const FIXTURE_RUNS = [
  failedRun('failure-filters-charge', '2026-11-02T16:30:00.000Z', 'charge-card'),
  failedRun('failure-filters-model', '2026-11-02T16:31:00.000Z', 'model'),
  {
    id: 'failure-filters-retrying',
    contextId: 'failure-filters-retrying',
    agentName: 'tool-runner',
    owner: 'anonymous:local',
    actor: null,
    kind: 'chat',
    origin: { kind: 'api' },
    status: 'working',
    finishReason: null,
    statusMessage: null,
    createdAt: '2026-11-02T16:40:00.000Z',
    updatedAt: '2026-11-02T16:40:00.000Z',
    cleanup: null,
    openWaits: [],
    failure: null,
    retrying: { label: 'charge-card', attempt: 3 },
  },
] as const;

/** Whether the Bureau would list `run` for a request that carries these filters. */
function listedFor(run: (typeof FIXTURE_RUNS)[number], request: ListRequest): boolean {
  const failedStep = run.failure?.step.label;
  return (
    (request['failedStep'] === undefined || request['failedStep'] === failedStep) &&
    (request['retrying'] === undefined || request['retrying'] === (run.retrying !== null)) &&
    (request['status'] === undefined || request['status'] === run.status)
  );
}

/** Adds the fixture runs to the real answer, and records every `bureau.tasks.list` request. */
async function listWithFixtureRuns(page: Page): Promise<ListRequest[]> {
  const requests: ListRequest[] = [];
  await page.route(isBureauCall, async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as {
      method?: string;
      params?: ListRequest;
    };
    if (body.method !== 'bureau.tasks.list') {
      await route.fallback();
      return;
    }
    const request = body.params ?? {};
    requests.push(request);
    const response = await route.fetch();
    const answer = (await response.json()) as { result?: { tasks?: unknown[] } };
    // The fixture runs are one page of the listing: a later page of the real answer adds none.
    const tasks = [
      ...(answer.result?.tasks ?? []),
      ...(request['pageToken'] === undefined
        ? FIXTURE_RUNS.filter((run) => listedFor(run, request))
        : []),
    ];
    await route.fulfill({ response, json: { ...answer, result: { ...answer.result, tasks } } });
  });
  return requests;
}

const filterBar = (page: Page) => page.getByRole('search', { name: 'Filter runs' });
const listedRuns = (page: Page) => page.locator('main li[data-run]');
const failedStepField = (page: Page) =>
  filterBar(page).getByRole('combobox', { name: 'Failed at step' });

/** Opens the list at the sample clock and waits until it is listed. */
async function openRuns(page: Page, path = '/runs', width = 1920): Promise<void> {
  await page.clock.setFixedTime(SAMPLE_NOW);
  // The wide desktop, where the bar holds every filter in its row: the specifications that press a
  // chip run here. The states the design review captures at the narrower widths, where the bar
  // folds some of its filters into the Filter menu, are opened by their address below.
  await page.setViewportSize({ width, height: 1080 });
  await page.goto(path);
  await expect(filterBar(page)).toBeVisible();
}

/**
 * The newest first page of the page's read of every run: a page of 100, with no status (the status
 * segments are applied in the browser). The read of the failed tasks that offers step names names
 * a status, and a chat's last run is a page of one, so neither is it. The page asks again as it
 * settles, so a spec polls this rather than reading the last request once.
 */
function newestRunsRead(requests: readonly ListRequest[]): ListRequest | undefined {
  return requests.findLast(
    (request) =>
      request['limit'] === 100 &&
      request['status'] === undefined &&
      request['pageToken'] === undefined,
  );
}

// Every title names `/runs`, so a design review's route filter (`--grep '/runs'`) runs it.
test.describe('/runs: the Retrying and Failed at step filters (COR-2535)', () => {
  test('Retrying narrows the Bureau’s list to the runs retrying a step, and the row names the step and its try', async ({
    page,
  }) => {
    const requests = await listWithFixtureRuns(page);
    await openRuns(page);
    await expect(listedRuns(page).first()).toBeVisible();
    await expect.poll(() => newestRunsRead(requests)).toBeDefined();
    expect(newestRunsRead(requests)).not.toHaveProperty('retrying');
    expect(newestRunsRead(requests)).not.toHaveProperty('failedStep');

    await filterBar(page).getByRole('button', { name: 'Retrying' }).click();
    await expect(page).toHaveURL(/[?&]retrying=true/);
    await expect(listedRuns(page)).toHaveCount(1);
    const row = page.locator('main li[data-run="failure-filters-retrying"]');
    await expect(row.locator('.cinder-stacked-list-item__line-two')).toContainText(
      'retrying charge-card, try 3, running 6 min',
    );
    await expect.poll(() => newestRunsRead(requests)).toMatchObject({ retrying: true });
    await captureForDesignReview(page, {
      route: '/runs',
      state: 'retrying filter on',
      source: SOURCE,
    });
  });

  test('Failed at step suggests the steps the runs failed at, and a chosen one narrows the list and the address', async ({
    page,
  }) => {
    const requests = await listWithFixtureRuns(page);
    await openRuns(page);
    await expect(listedRuns(page).first()).toBeVisible();

    await failedStepField(page).click();
    await failedStepField(page).fill('c');
    // The steps the listed runs failed at that hold the typed letter.
    await expect(page.getByRole('option', { name: 'charge-card', exact: true })).toBeVisible();
    await expect(page.getByRole('option', { name: 'model', exact: true })).toHaveCount(0);
    await captureForDesignReview(page, {
      route: '/runs',
      state: 'failed at step suggestions',
      source: SOURCE,
    });
    await page.getByRole('option', { name: 'charge-card', exact: true }).click();

    await expect(page).toHaveURL(/[?&]failedStep=charge-card/);
    await expect(listedRuns(page)).toHaveCount(1);
    await expect(page.locator('main li[data-run="failure-filters-charge"]')).toBeVisible();
    await expect.poll(() => newestRunsRead(requests)).toMatchObject({ failedStep: 'charge-card' });
    // The other step stays offered while the list is narrowed to this one, so another can be
    // chosen. The names come from a second read that answers after the list, and suggestions are
    // made as a letter is typed: type again until the read has answered. The field is never
    // emptied, which would take the filter out.
    await expect(async () => {
      await failedStepField(page).fill('mo');
      await failedStepField(page).fill('mod');
      await expect(page.getByRole('option', { name: 'model', exact: true })).toBeVisible();
    }).toPass();
    await captureForDesignReview(page, {
      route: '/runs',
      state: 'failed at step filter on',
      source: SOURCE,
    });
  });

  test('a typed name is sent on Enter, and the address restores the filtered list on reload', async ({
    page,
  }) => {
    const requests = await listWithFixtureRuns(page);
    await openRuns(page);
    await expect(listedRuns(page).first()).toBeVisible();

    await failedStepField(page).fill('model');
    // Nothing is asked of the Bureau, and the address keeps nothing, until Enter.
    expect(requests.filter((request) => request['failedStep'] !== undefined)).toEqual([]);
    await expect(page).not.toHaveURL(/failedStep/);
    await failedStepField(page).press('Enter');
    await expect(page).toHaveURL(/[?&]failedStep=model/);
    await expect(listedRuns(page)).toHaveCount(1);
    await expect(page.locator('main li[data-run="failure-filters-model"]')).toBeVisible();

    await page.reload();
    await expect(filterBar(page)).toBeVisible();
    await expect(failedStepField(page)).toHaveValue('model');
    await expect(listedRuns(page)).toHaveCount(1);
    await expect(page.locator('main li[data-run="failure-filters-model"]')).toBeVisible();
    await expect.poll(() => newestRunsRead(requests)).toMatchObject({ failedStep: 'model' });
  });

  test('both combine with the status filter, and a pair that matches nothing says so and offers Clear filters', async ({
    page,
  }) => {
    const requests = await listWithFixtureRuns(page);
    await openRuns(page, '/runs?status=failed&failedStep=charge-card');
    await expect(listedRuns(page)).toHaveCount(1);
    await expect(page.locator('main li[data-run="failure-filters-charge"]')).toBeVisible();
    await expect.poll(() => newestRunsRead(requests)).toMatchObject({ failedStep: 'charge-card' });

    // A run that retries a step has not failed at one: the pair lists nothing.
    await filterBar(page).getByRole('button', { name: 'Retrying' }).click();
    await expect(page).toHaveURL(/[?&]retrying=true/);
    await expect(page).toHaveURL(/[?&]failedStep=charge-card/);
    await expect(page).toHaveURL(/[?&]status=failed/);
    await expect(
      page.getByRole('heading', { level: 2, name: TASK_COPY.noMatch.title }),
    ).toBeVisible();
    await expect(
      page.getByText(
        'No failed runs retrying a step that failed at charge-card. Try another status or step.',
      ),
    ).toBeVisible();
    await expect
      .poll(() => newestRunsRead(requests))
      .toMatchObject({ retrying: true, failedStep: 'charge-card' });
    await captureForDesignReview(page, {
      route: '/runs',
      state: 'failure filters match nothing',
      source: SOURCE,
    });

    await page.getByRole('button', { name: TASK_COPY.clearAction }).click();
    await expect(page).not.toHaveURL(/failedStep|retrying/);
    await expect(listedRuns(page).first()).toBeVisible();
  });
});

// The bar holds fewer of its filters in its row as it narrows, so each state the design review
// captures is opened by its address, never by pressing a chip that may have moved into the menu.
for (const width of [1280, 375] as const) {
  test(`/runs: the Retrying and Failed at step lists, opened by their address, at ${String(width)} pixels (COR-2535)`, async ({
    page,
  }) => {
    await listWithFixtureRuns(page);
    await openRuns(page, '/runs?retrying=true', width);
    await expect(listedRuns(page)).toHaveCount(1);
    await expect(page.locator('main li[data-run="failure-filters-retrying"]')).toBeVisible();
    await captureForDesignReview(page, {
      route: '/runs',
      state: 'retrying filter in the address',
      source: SOURCE,
    });

    await page.goto('/runs?failedStep=charge-card');
    await expect(listedRuns(page)).toHaveCount(1);
    await expect(page.locator('main li[data-run="failure-filters-charge"]')).toBeVisible();
    await captureForDesignReview(page, {
      route: '/runs',
      state: 'failed at step filter in the address',
      source: SOURCE,
    });
  });
}

test.describe('/health/runs: the query builder (COR-2535)', () => {
  test('offers Failed at step and Retrying, and an address carrying both sends them to the engine’s list', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    const sent = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return (
        url.pathname.endsWith('/workflows') &&
        url.searchParams.get('failed_step') === 'charge-card' &&
        url.searchParams.get('retrying') === 'true'
      );
    });
    await page.goto('/health/runs?failed_step=charge-card&retrying=true');
    await sent;
    // The builder opens on the two conditions, the step named in the first.
    await expect(page.getByLabel(/Value for condition 1/).first()).toHaveValue('charge-card');
    await captureForDesignReview(page, {
      route: '/health/runs',
      state: 'failure filters in the query builder',
      source: SOURCE,
    });
  });
});
