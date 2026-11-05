/**
 * The Schedules list on the sample world's four schedules (`fixtures/sample-world-seed.ts`, the
 * showcase host; COR-2018, rows 10v–10y, 70a–70n, 11o–11q), and the row states that sample world
 * does not hold (rows 70z, 71b, 71c). The list is read at 1280 and 375 pixels: the status leads
 * each row on a desktop and moves to line two on a phone, where a third line says why a schedule
 * will not run and ends in its cadence.
 *
 * A schedule whose workflow was deleted cannot exist in the sample world: deleting a workflow's
 * file cancels its schedule. The captioned frame is drawn by answering the two reads that make the
 * list (the engine's schedules and the Bureau's saved versions of the workflow) with the one extra
 * schedule, Weekly cleanup, paused since its workflow was deleted, and with Inbox triage resumed,
 * so the frame's own counts hold: All 5, Active 4, Paused 1. Everything else is the sample world.
 */
import type { Page, Route } from '@playwright/test';

import { SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'schedules-list.spec.ts';
const WIDTHS = [1280, 375] as const;

/** Waits for the rows to hold what the Bureau says of them, which is read after the list. */
async function listed(page: Page, rows: number): Promise<void> {
  const list = page.locator('main li[data-schedule]');
  await expect(list).toHaveCount(rows);
  // The workflow that can't load names its agent from its last saved version, and says a provider is
  // missing once the agent's model is read; both come after the list. A desktop row says the agent
  // on line two and a phone's third line says the provider, so each is read where it is said.
  const refund = list.filter({ hasText: 'Weekly refund audit' });
  const phone = (page.viewportSize()?.width ?? 1280) < 640;
  await expect(
    phone
      ? refund.getByTestId('schedule-line-three')
      : refund.locator('.cinder-stacked-list-item__meta'),
  ).toContainText(phone ? 'provider' : 'Tool runner');
}

for (const width of WIDTHS) {
  test(`the sample world's four schedules, missed runs first, with the reason and the cadence as the design says, at ${width} pixels`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/schedules');
    await listed(page, 4);
    const main = page.locator('main');

    await expect(main.getByRole('heading', { level: 1, name: 'Schedules' })).toBeVisible();
    await expect(main).toContainText('Runs that start on a timetable. Times are in Central time.');
    await expect(main.getByRole('button', { name: 'New schedule' })).toBeVisible();
    if (width >= 1024) {
      for (const name of [/^All\s*,\s*4$/, /^Active\s*,\s*3$/, /^Paused\s*,\s*1$/]) {
        await expect(main.getByRole('radio', { name })).toBeVisible();
      }
    }

    const titles = main.locator('li[data-schedule] .cinder-stacked-list-item__title');
    await expect(titles).toHaveText([
      'Daily summary',
      'Weekly refund audit',
      'Release notes digest',
      'Inbox triage',
    ]);
    const words = main.locator('li[data-schedule]');
    await expect(words.nth(0)).toHaveAttribute('data-status-word', 'Missed runs · 4');
    await expect(words.nth(1)).toHaveAttribute('data-status-word', 'Active');
    await expect(words.nth(3)).toHaveAttribute('data-status-word', 'Paused');

    const refund = words.nth(1);
    await expect(refund).toContainText('can’t load');
    if (width >= 640) {
      await expect(refund).toContainText(/Due .+ · won’t start/);
      await expect(refund).not.toContainText('provider');
    } else {
      // A phone's third line says the workflow first, then the provider, then the cadence.
      await expect(refund.getByTestId('schedule-line-three')).toContainText(
        'Order refund can’t load · won’t run until a provider is connected · Mondays at',
      );
      // Rows are at least 44px tall.
      for (const row of await words.all()) {
        const box = await row.boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      }
    }
    await captureForDesignReview(page, { route: '/schedules', state: 'ready', source: SOURCE });
  });
}

/** Answers a read with the response the host gave, changed by `change`. */
async function changed(route: Route, change: (body: Record<string, unknown>) => void) {
  const response = await route.fetch();
  const body = (await response.json()) as Record<string, unknown>;
  change(body);
  await route.fulfill({ response, json: body });
}

/** The Bureau's JSON-RPC method a request carries, and its parameters. */
function bureauRequest(route: Route): { method: string; params: Record<string, unknown> } {
  const body = route.request().postDataJSON() as {
    method?: string;
    params?: Record<string, unknown>;
  };
  return { method: body.method ?? '', params: body.params ?? {} };
}

const CLEANUP = 'weekly-cleanup';
const NOW_MS = Date.parse('2026-11-02T16:46:00.000Z');

/** Weekly cleanup paused since its workflow was deleted, and Inbox triage resumed. */
async function drawRowStatesOutsideTheSampleWorld(page: Page): Promise<void> {
  await page.route(/\/v1\/schedules(\?|$)/, async (route) => {
    await changed(route, (body) => {
      const items = body['items'] as Record<string, unknown>[];
      const triage = items.find((item) => item['description'] === 'Inbox triage');
      if (triage === undefined) throw new Error('the sample world lists Inbox triage');
      triage['status'] = 'active';
      triage['nextFireAt'] = NOW_MS + 21 * 3_600_000;
      items.push({
        ...triage,
        id: 'schedule-weekly-cleanup',
        description: 'Weekly cleanup',
        workflowType: CLEANUP,
        status: 'paused',
        cronExpression: '0 2 * * 0',
        timeZone: 'America/Chicago',
        lastFireAt: Date.parse('2026-10-25T07:00:00.000Z'),
        nextFireAt: Date.parse('2026-11-08T08:00:00.000Z'),
      });
      body['total'] = items.length;
    });
  });
  await page.route('**/bureau/jsonrpc', async (route) => {
    const { method, params } = bureauRequest(route);
    if (method === 'bureau.schedules.list') {
      await changed(route, (body) => {
        const result = (body['result'] ?? body) as { schedules: Record<string, unknown>[] };
        for (const schedule of result.schedules) {
          if (schedule['description'] === 'Inbox triage') schedule['status'] = 'active';
        }
      });
      return;
    }
    if (method === 'bureau.workflows.history' && params['id'] === CLEANUP) {
      await route.fulfill({
        json: {
          jsonrpc: '2.0',
          id: method,
          result: {
            revisions: [
              { current: false, steps: [{ handler: 'agent', input: { agent: 'tool-runner' } }] },
            ],
          },
        },
      });
      return;
    }
    await route.fallback();
  });
}

for (const width of WIDTHS) {
  test(`a schedule whose workflow was deleted is Can't find workflow in red with no next run, beside counts that are the frame's own, at ${width} pixels`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await drawRowStatesOutsideTheSampleWorld(page);
    await page.goto('/schedules');
    await listed(page, 5);
    const main = page.locator('main');

    const cleanup = main.locator('li[data-schedule]', { hasText: 'Weekly cleanup' });
    await expect(cleanup).toHaveAttribute('data-status-word', "Can't find workflow");
    await expect(cleanup).toContainText('weekly-cleanup was deleted');
    // A desktop row sets the identifier small and monospaced; a phone says it on its third line.
    if (width >= 640) await expect(cleanup.locator('code')).toHaveText('weekly-cleanup');
    await expect(cleanup).toContainText(width >= 640 ? 'No next run' : '—');
    // The dot and the word are red, because it can't run at all.
    await expect(cleanup.locator('[data-cinder-status="danger"]')).toBeVisible();
    // The frame's own counts: All 5, Active 4, Paused 1, and the Missed runs chip.
    for (const name of [/^All\s*,\s*5$/, /^Active\s*,\s*4$/, /^Paused\s*,\s*1$/]) {
      if (width >= 1024) await expect(main.getByRole('radio', { name })).toBeVisible();
    }
    await captureForDesignReview(page, {
      route: '/schedules (row states outside the sample world)',
      state: 'ready',
      source: SOURCE,
    });
  });
}
