/**
 * The schedules pages against the real host: the list is a table, a schedule made in a time zone
 * shows its next runs in that zone with the zone named, Skip the next one marks exactly that run,
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

test('lists every schedule in a table with the workflow each one runs', async ({
  page,
  checkA11y,
}) => {
  await page.goto('/schedules');
  const table = page.getByRole('table', { name: /Schedules, with the workflow each one runs/ });
  const row = table.locator(`tr[data-schedule="${SCHEDULE_ID}"]`);
  await expect(row).toBeVisible();
  await expect(row.getByRole('link', { name: DESCRIPTION })).toHaveAttribute(
    'href',
    `/schedules/${SCHEDULE_ID}`,
  );
  await expect(row.getByRole('link', { name: 'inventory-sync-sweep' })).toBeVisible();
  // A cron's zone is named beside its cadence.
  await expect(row).toContainText('in Asia/Tokyo');
  await expect(row).toHaveAttribute('data-status-word', 'Scheduled');
  await checkA11y('schedules — the table');
});

for (const width of WIDTHS) {
  test(`shows the next runs in the schedule’s zone, with the zone named, at ${width} pixels`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/schedules/${SCHEDULE_ID}`);

    await expect(page.getByRole('heading', { level: 1, name: DESCRIPTION })).toBeVisible();
    await expect(page.getByTestId('schedule-zone')).toContainText('Asia/Tokyo');
    await expect(page.getByTestId('schedule-status-line')).toContainText('in Asia/Tokyo');
    const runs = page.getByTestId('schedule-next-fires').locator('time');
    await expect(runs).toHaveCount(5);
    // Every run is 09:00 on the Tokyo clock, whatever zone the browser is in.
    for (const text of await runs.allTextContents()) expect(text).toMatch(/9:00\s?AM GMT\+9/);
    await expect(page.getByTestId('schedule-rail-zone')).toHaveText('Asia/Tokyo');
    await checkA11y(`schedule detail — next runs at ${width}px`);
  });
}

test('Skip the next one marks exactly that run, and the mark survives a reload', async ({
  page,
  request,
}) => {
  await page.goto(`/schedules/${SCHEDULE_ID}`);
  const items = page.getByTestId('schedule-next-fires').locator('li');
  await expect(items).toHaveCount(5);

  // The skip names the run the page showed, so a fire between the read and the write cannot make it
  // take a different one.
  const shown = Date.parse(
    (await items.first().locator('time').getAttribute('datetime')) ?? 'not a time',
  );
  const skipRequest = page.waitForRequest(
    (candidate) => candidate.method() === 'POST' && candidate.url().endsWith('/skip-next'),
  );
  await page.getByRole('button', { name: 'Skip the next one' }).click();
  const sent = await skipRequest;
  expect(sent.postDataJSON()).toEqual({ occurrence: shown });

  await expect(items.first()).toHaveAttribute('data-skipped', 'true');
  await expect(items.nth(1)).toHaveAttribute('data-skipped', 'false');
  await expect(page.getByRole('button', { name: 'Skip the next one' })).toHaveCount(0);
  const read = await request.get(`/v1/schedules/${SCHEDULE_ID}`);
  const schedule = (await read.json()) as { skipUntil?: number };
  expect(schedule.skipUntil).toBe(shown);

  await page.reload();
  await expect(items.first()).toHaveAttribute('data-skipped', 'true');
  await expect(page.getByRole('button', { name: 'Skip the next one' })).toHaveCount(0);
});

test('Run now starts one run, links to it, and lists it under past runs after a reload', async ({
  page,
  request,
  checkA11y,
}) => {
  await page.goto(`/schedules/${SCHEDULE_ID}`);
  await expect(page.getByText('No runs yet')).toBeVisible();

  await page.getByRole('button', { name: 'Run now' }).click();

  const result = page.getByTestId('schedule-run-now');
  await expect(result).toHaveAttribute('data-outcome', 'started');
  await expect(result.getByRole('link', { name: 'View the run' })).toHaveAttribute(
    'href',
    /\/runs\//,
  );
  const past = page.getByRole('table', { name: /Runs this schedule started/ });
  await expect(past.locator('tbody tr')).toHaveCount(1);
  const listed = await request.get(`/v1/workflows?schedule_id=${SCHEDULE_ID}`);
  const runs = (await listed.json()) as { items: unknown[] };
  expect(runs.items).toHaveLength(1);
  await checkA11y('schedule detail — a run started now');

  await page.reload();
  await expect(past.locator('tbody tr')).toHaveCount(1);
});

test('the On switch turns the schedule off and on, and Run now still works while it is off', async ({
  page,
}) => {
  await page.goto(`/schedules/${SCHEDULE_ID}`);
  const toggle = page.getByRole('switch', { name: 'On' });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  await toggle.click();

  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByText('Nothing is coming up')).toBeVisible();
  await expect(page.getByTestId('schedule-next-fires')).toHaveCount(0);
  await page.getByRole('button', { name: 'Run now' }).click();
  await expect(page.getByTestId('schedule-run-now')).toHaveAttribute('data-outcome', 'started');

  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('schedule-next-fires').locator('li')).toHaveCount(5);
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

  // Chosen by typing, from the searchable picker.
  await page.getByRole('combobox', { name: /^Workflow/ }).fill('inventory');
  await page.getByRole('option', { name: /Inventory Sync Sweep/ }).click();
  await expect(page.getByTestId('new-schedule-workflow-description')).toBeVisible();

  await page.getByLabel('Repeats', { exact: true }).selectOption('daily');
  await page.getByLabel('At', { exact: true }).fill('09:00');
  await page.getByRole('combobox', { name: 'Time zone' }).fill('Asia/Tokyo');
  await page.getByRole('option', { name: 'Asia/Tokyo', exact: true }).click();
  await page.getByLabel(SCHEDULE_COPY.create.descriptionLabel).fill('Made on the page');
  await expect(page.getByTestId('new-schedule-summary')).toContainText('Asia/Tokyo');
  await checkA11y('new schedule — a workflow and a zone chosen');
  await page.getByRole('button', { name: SCHEDULE_COPY.create.submit }).click();

  await expect(page).toHaveURL(/\/schedules\/[^/?]+$/);
  const id = decodeURIComponent(new URL(page.url()).pathname.split('/').pop() ?? '');
  try {
    // Every next run is 09:00 on the Tokyo clock, whatever zone the browser is in.
    const runs = page.getByTestId('schedule-next-fires').locator('time');
    await expect(runs).toHaveCount(5);
    for (const text of await runs.allTextContents()) expect(text).toMatch(/9:00\s?AM GMT\+9/);
    await expect(page.getByTestId('schedule-rail-zone')).toHaveText('Asia/Tokyo');
    await expect(page.getByTestId('schedule-status-line')).toContainText('in Asia/Tokyo');
  } finally {
    await request.delete(`/v1/schedules/${encodeURIComponent(id)}`);
  }
});

test('an invalid custom cron field refuses the save, and nothing is made', async ({
  page,
  request,
}) => {
  await page.goto('/schedules/new');
  await page.getByRole('combobox', { name: /^Workflow/ }).fill('inventory');
  await page.getByRole('option', { name: /Inventory Sync Sweep/ }).click();
  await page.getByLabel('Repeats', { exact: true }).selectOption('cron');
  // A field of the expression is typed raw, under its own "Advanced raw expression".
  await page.getByLabel('Hour pattern').selectOption('advanced');
  await page.getByLabel('Hour', { exact: true }).fill('99');
  await page.getByLabel(SCHEDULE_COPY.create.descriptionLabel).fill('Refused for its cron');

  await page.getByRole('button', { name: SCHEDULE_COPY.create.submit }).click();

  await expect(page.getByText(SCHEDULE_COPY.create.invalidCadence)).toBeVisible();
  await expect(page).toHaveURL(/\/schedules\/new$/);
  const listed = await request.get('/v1/schedules');
  const body = (await listed.json()) as { items: Array<{ description?: string }> };
  expect(body.items.some((item) => item.description === 'Refused for its cron')).toBe(false);
});
