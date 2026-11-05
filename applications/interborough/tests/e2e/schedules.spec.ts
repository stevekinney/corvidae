/**
 * The schedules pages against the real host: the list is a table, a schedule made in a time zone
 * shows its next runs in the viewer’s zone, Skip marks exactly the next run,
 * Run now starts one run and links to it, and the runs it started are still listed after a reload.
 * The missed-fire rows are persisted by the engine and read back on every mount; the component
 * tests move the engine's clock to make it miss fires (`schedule-detail.test.ts`), which a running
 * host cannot be asked to do.
 *
 * Every schedule here is made through the host's REST API and removed after the file.
 */
import type { APIRequestContext } from '@playwright/test';

import { SCHEDULE_COPY } from '../../src/app/copy.ts';
import { expect, test } from './fixtures.ts';

/**
 * The identifier of the schedule the running spec made. A cancelled schedule keeps its identifier, so
 * each spec makes one of its own.
 */
let SCHEDULE_ID = '';
let made = 0;
const DESCRIPTION = 'Tokyo morning sync';
const WIDTHS = [375, 768, 1280] as const;

async function createSchedule(request: APIRequestContext): Promise<void> {
  made += 1;
  SCHEDULE_ID = `e2e-schedules-tokyo-${String(Date.now())}-${String(made)}`;
  const response = await request.post('/v1/schedules', {
    data: {
      type: 'inventory-sync-sweep',
      id: SCHEDULE_ID,
      description: DESCRIPTION,
      cronExpression: '0 9 * * *',
      timeZone: 'Asia/Tokyo',
      input: { warehouseId: 'wh-main' },
    },
  });
  expect(response.status(), 'creating the schedule').toBe(201);
}

test.beforeEach(async ({ request }) => {
  await createSchedule(request);
});

test.afterEach(async ({ request }) => {
  await request.delete(`/v1/schedules/${SCHEDULE_ID}`);
});

test('lists every schedule as a row that links to it, with the workflow each one runs', async ({
  page,
  checkA11y,
}) => {
  await page.goto('/schedules');
  const row = page.locator(`li[data-schedule="${SCHEDULE_ID}"]`);
  await expect(row).toBeVisible();
  await expect(row.getByRole('link', { name: DESCRIPTION })).toHaveAttribute(
    'href',
    `/schedules/${SCHEDULE_ID}`,
  );
  // Line two says the kind first, then the workflow.
  await expect(row).toContainText('Workflow · Inventory sync sweep');
  await expect(row).toHaveAttribute('data-status-word', 'Active');
  await checkA11y('schedules — the list');
});

for (const width of WIDTHS) {
  test(`shows the next three runs in the viewer’s zone, farthest first, at ${width} pixels`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/schedules/${SCHEDULE_ID}`);

    await expect(page.getByRole('heading', { level: 1, name: DESCRIPTION })).toBeVisible();
    await expect(page.getByTestId('schedule-zone')).toContainText('times in');
    // The sentence says the schedule's own zone, which the runs below do not use.
    await expect(page.getByTestId('schedule-status-line')).toContainText('9:00 AM GMT+9');
    const runs = page.getByTestId('schedule-runs').locator('li[data-cinder-tone="pending"] time');
    await expect(runs).toHaveCount(3);
    const stamps = await runs.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('datetime') ?? ''),
    );
    const times = stamps.map((stamp) => Date.parse(stamp));
    expect(times).toEqual(times.toSorted((first, second) => second - first));
    await checkA11y(`schedule detail — next runs at ${width}px`);
  });
}

test('Skip skips exactly the next run, crosses its time out, and the mark survives a reload', async ({
  page,
  request,
}) => {
  await page.goto(`/schedules/${SCHEDULE_ID}`);
  const pending = page.getByTestId('schedule-runs').locator('li[data-cinder-tone="pending"]');
  await expect(pending).toHaveCount(3);

  // The skip names the run the page showed, the nearest, which sits against the Now marker, so a
  // fire between the read and the write cannot make it take a different one.
  const shown = Date.parse(
    (await pending.last().locator('time').getAttribute('datetime')) ?? 'not a time',
  );
  const skipRequest = page.waitForRequest(
    (candidate) => candidate.method() === 'POST' && candidate.url().endsWith('/skip-next'),
  );
  await page.getByRole('button', { name: /^Skip / }).click();
  const sent = await skipRequest;
  expect(sent.postDataJSON()).toEqual({ occurrence: shown });

  const struck = page.getByTestId('schedule-runs').locator('time[data-cinder-struck]');
  await expect(struck).toHaveCount(1);
  await expect(pending.last().locator('time')).toHaveAttribute('data-cinder-struck', '');
  await expect(page.getByTestId('schedule-skipped')).toHaveText('Skipped');
  await expect(page.getByRole('button', { name: /^Skip / })).toHaveCount(0);
  const read = await request.get(`/v1/schedules/${SCHEDULE_ID}`);
  const schedule = (await read.json()) as { skipUntil?: number };
  expect(schedule.skipUntil).toBe(shown);

  await page.reload();
  await expect(struck).toHaveCount(1);
  await expect(page.getByRole('button', { name: /^Skip / })).toHaveCount(0);
});

test('Run now starts one run, links to it, and lists it under past runs after a reload', async ({
  page,
  request,
  checkA11y,
}) => {
  await page.goto(`/schedules/${SCHEDULE_ID}`);
  await expect(page.getByRole('group', { name: 'No runs yet.' })).toBeVisible();

  await page.getByRole('button', { name: 'Run now' }).click();

  // A toast says so, and links to the run.
  await expect(page.getByText(/^Started /)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open run' })).toBeVisible();
  const past = page.getByTestId('schedule-runs').locator('li[data-cinder-kind="run"]');
  await expect(past).toHaveCount(1);
  const listed = await request.get(`/v1/workflows?schedule_id=${SCHEDULE_ID}`);
  const runs = (await listed.json()) as { items: unknown[] };
  expect(runs.items).toHaveLength(1);
  await checkA11y('schedule detail — a run started now');

  await page.reload();
  await expect(past).toHaveCount(1);
});

test('the Active switch turns the schedule off and on, and Run now still works while it is off', async ({
  page,
}) => {
  await page.goto(`/schedules/${SCHEDULE_ID}`);
  const toggle = page.getByRole('switch', { name: /^Active, / });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  await toggle.click();

  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByText('No upcoming runs while the schedule is paused.')).toBeVisible();
  await expect(
    page.getByTestId('schedule-runs').locator('li[data-cinder-tone="pending"]'),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Run now' }).click();
  await expect(page.getByText(/^Started /)).toBeVisible();

  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(
    page.getByTestId('schedule-runs').locator('li[data-cinder-tone="pending"]'),
  ).toHaveCount(3);
});

test('a schedule made on the new schedule page fires in the zone that was chosen', async ({
  page,
  request,
  checkA11y,
}) => {
  await page.goto('/schedules/new');
  await expect(
    page.getByRole('heading', { level: 1, name: SCHEDULE_COPY.create.title }),
  ).toBeVisible();

  // Chosen from the picker, which shows the workflow's name and, under it, what it says it is for.
  await page.getByRole('combobox', { name: /^Workflow/ }).click();
  await page.getByRole('option', { name: /Inventory sync sweep/ }).click();
  await expect(page.getByRole('combobox', { name: /^Workflow/ })).toContainText(
    'Inventory sync sweep',
  );

  await page.getByLabel('Repeats', { exact: true }).selectOption('daily');
  await page.getByLabel('At', { exact: true }).fill('9:00 AM');
  await page.getByRole('combobox', { name: /^Time zone/ }).click();
  await page.getByPlaceholder('Search time zones').fill('Tokyo');
  await page.getByRole('option', { name: /Tokyo/ }).first().click();
  await page.getByLabel(/^Name/).fill('Made on the page');
  await expect(page.getByText('Every day at 9:00 AM Japan').first()).toBeVisible();
  await checkA11y('new schedule — a workflow and a zone chosen');
  await page.getByRole('button', { name: SCHEDULE_COPY.create.submit }).click();

  await expect(page).toHaveURL(/\/schedules\/[^/?]+$/);
  const id = decodeURIComponent(new URL(page.url()).pathname.split('/').pop() ?? '');
  try {
    // The next three runs are listed in the viewer's zone; the sentence names the Tokyo clock.
    await expect(
      page.getByTestId('schedule-runs').locator('li[data-cinder-tone="pending"] time'),
    ).toHaveCount(3);
    await expect(page.getByTestId('schedule-status-line')).toContainText('9:00 AM GMT+9');
  } finally {
    await request.delete(`/v1/schedules/${encodeURIComponent(id)}`);
  }
});

test('an invalid custom cron field moves focus to it on Create, and nothing is made', async ({
  page,
  request,
}) => {
  await page.goto('/schedules/new');
  await page.getByRole('combobox', { name: /^Workflow/ }).click();
  await page.getByRole('option', { name: /Inventory sync sweep/ }).click();
  await page.getByLabel('Repeats', { exact: true }).selectOption('cron');
  await page.getByLabel('Hour', { exact: true }).fill('99');
  await page.getByLabel(/^Name/).fill('Refused for its cron');

  await page.getByRole('button', { name: SCHEDULE_COPY.create.submit }).click();

  // Create stays enabled; focus moves to the field with its message beside it.
  await expect(page.getByLabel('Hour', { exact: true })).toBeFocused();
  await expect(page).toHaveURL(/\/schedules\/new$/);
  const listed = await request.get('/v1/schedules');
  const body = (await listed.json()) as { items: Array<{ description?: string }> };
  expect(body.items.some((item) => item.description === 'Refused for its cron')).toBe(false);
});
