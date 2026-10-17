/**
 * Primary WFC-18 operator flow against a real, seeded durable Weft task
 * ledger, plus COR-124's attempt, lease, and cancellation evidence. Every task
 * here is produced by `e2e-server.ts` through real Weft operations (see
 * `ledger-evidence-seed.ts`); nothing in this spec stubs a response.
 */
import type { Locator, Page } from '@playwright/test';

import { expect, test } from './auth-fixtures.ts';
import {
  E2E_CANCELLATION_REASON,
  E2E_CANCELLED_TASK_OPERATION_ID,
  E2E_CANCELLING_TASK_OPERATION_ID,
  E2E_LEASED_TASK_OPERATION_ID,
  E2E_TASK_OPERATION_ID,
} from './e2e-constants.ts';

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
] as const;

const EVIDENCE_TASKS = [
  E2E_LEASED_TASK_OPERATION_ID,
  E2E_CANCELLING_TASK_OPERATION_ID,
  E2E_CANCELLED_TASK_OPERATION_ID,
] as const;

async function openTask(page: Page, operationId: string): Promise<void> {
  await page.goto(`/workers?tab=diagnostics&task=${operationId}`);
  await expect(page.getByRole('heading', { name: 'Authoritative task ledger' })).toBeVisible();
  await expect(page.getByText(operationId, { exact: true })).toBeVisible();
}

function region(page: Page, name: string): Locator {
  return page.getByRole('region', { name, exact: true });
}

function clock(page: Page, id: string): Locator {
  return region(page, 'Lease clocks').locator(`[data-clock="${id}"]`);
}

async function expectIsoDeadline(container: Locator): Promise<void> {
  const time = container.locator('time');
  await expect(time).toHaveAttribute('datetime', ISO_INSTANT);
  await expect(time).toHaveText(ISO_INSTANT);
}

async function expectNoHorizontalOverflow(locator: Locator, label: string): Promise<void> {
  const overflow = await locator.evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(overflow, `${label} overflows horizontally`).toBeLessThanOrEqual(0);
}

test('operator inspects a seeded authoritative task ledger', async ({ page, checkA11y }) => {
  await openTask(page, E2E_TASK_OPERATION_ID);

  await expect(page.getByText('queued')).toBeVisible();
  await expect(page.getByText('Available · attempt 1 of 3')).toBeVisible();
  await expect(page.getByText('traceparent')).toBeVisible();
  await expect(page.getByText('No heartbeat recorded')).toBeVisible();

  // COR-124: three independently labeled clocks, the fenced attempt history, and cancellation.
  const clocks = region(page, 'Lease clocks');
  await expect(clocks.getByText('Session lease')).toBeVisible();
  await expect(clocks.getByText('Attempt lease')).toBeVisible();
  await expect(clocks.getByText('Absolute execution deadline')).toBeVisible();
  await expect(clocks.getByText('Not leased')).toBeVisible();
  await expect(region(page, 'Attempt history')).toBeVisible();
  await expect(region(page, 'Cancellation evidence').getByText('Not requested')).toBeVisible();

  await checkA11y('workers—authoritative delayed task ledger');
});

test('a leased second attempt shows its fenced history, lease clocks, and heartbeat', async ({
  page,
  checkA11y,
}) => {
  await openTask(page, E2E_LEASED_TASK_OPERATION_ID);

  // The real dispatch carries the qualified routing name; it is shown once.
  await expect(page.getByText('order-processing.chargeCard', { exact: true })).toBeVisible();
  await expect(page.getByText('order-processing.order-processing.chargeCard')).toHaveCount(0);

  // Attempt 1 was requeued when its worker disconnected; attempt 2 holds the lease.
  const timeline = page.getByRole('list', { name: 'Attempt history' });
  await expect(timeline.getByRole('listitem')).toHaveCount(2);
  const first = timeline.locator('[data-attempt="1"]');
  await expect(first.getByText('Requeued', { exact: true })).toBeVisible();
  await expect(first.getByText('Superseded', { exact: true })).toBeVisible();
  await expect(first.getByText('worker-disconnect')).toBeVisible();
  await expect(timeline.getByText('Attempt 2 · current')).toBeVisible();
  await expect(timeline.locator('[data-attempt="2"]').getByText(/→ still held$/)).toBeVisible();

  const session = clock(page, 'session-lease');
  await expect(session.getByText('Active', { exact: true })).toBeVisible();
  await expectIsoDeadline(session);
  const attemptLease = clock(page, 'attempt-lease');
  await expect(attemptLease.getByText('Active', { exact: true })).toBeVisible();
  await expectIsoDeadline(attemptLease);
  await expect(clock(page, 'execution-deadline').getByText('No deadline')).toBeVisible();

  const heartbeat = clock(page, 'heartbeat');
  await expect(heartbeat.getByText('Heartbeat', { exact: true })).toBeVisible();
  await expectIsoDeadline(heartbeat);

  await expect(region(page, 'Cancellation evidence').getByText('Not requested')).toBeVisible();

  await checkA11y('workers—leased task with two attempts');
});

test('a requested cancellation reads as awaiting acknowledgement, never as expiry', async ({
  page,
  checkA11y,
}) => {
  await openTask(page, E2E_CANCELLING_TASK_OPERATION_ID);

  const cancellation = region(page, 'Cancellation evidence');
  await expect(cancellation.getByText('Requested · awaiting worker acknowledgement')).toBeVisible();
  await expect(cancellation.getByText(E2E_CANCELLATION_REASON)).toBeVisible();
  await expect(cancellation.getByText(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z \(/)).toBeVisible();
  await expect(cancellation.getByText('Not acknowledged · attempt 1 is leased')).toBeVisible();

  // The lease is still running: cancellation never borrows a clock's wording.
  await expect(clock(page, 'session-lease').getByText('Active', { exact: true })).toBeVisible();
  await expect(clock(page, 'heartbeat')).toBeVisible();

  await checkA11y('workers—task with requested cancellation');
});

test('an acknowledged cancellation is attributed to the owning attempt', async ({
  page,
  checkA11y,
}) => {
  await openTask(page, E2E_CANCELLED_TASK_OPERATION_ID);

  const cancellation = region(page, 'Cancellation evidence');
  await expect(cancellation.getByText('Acknowledged by owning attempt')).toBeVisible();
  await expect(cancellation.getByText(/^Acknowledged by attempt 1 at \d{4}-/)).toBeVisible();
  await expect(cancellation.getByText(E2E_CANCELLATION_REASON)).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Attempt history' }).getByText('Cancelled', { exact: true }),
  ).toBeVisible();

  await checkA11y('workers—task with acknowledged cancellation');
});

for (const theme of ['light', 'dark'] as const) {
  test(`task ledger remains usable at supported widths in the ${theme} theme`, async ({
    page,
    checkA11y,
  }) => {
    await page.addInitScript((selectedTheme) => {
      localStorage.setItem('weft-ui-theme', selectedTheme);
    }, theme);
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      await openTask(page, E2E_TASK_OPERATION_ID);

      const label = `${E2E_TASK_OPERATION_ID} (${theme}, ${viewport.width}px)`;
      await expect(region(page, 'Lease clocks')).toBeVisible();
      await expect(region(page, 'Attempt history')).toBeVisible();
      await expect(region(page, 'Cancellation evidence')).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expectNoHorizontalOverflow(region(page, 'Lease clocks'), `${label} lease clocks`);
      await expectNoHorizontalOverflow(
        region(page, 'Cancellation evidence'),
        `${label} cancellation evidence`,
      );
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `${label} page width`,
      ).toBe(true);
      await checkA11y(label);
    }
  });
}

for (const theme of ['light', 'dark'] as const) {
  for (const operationId of EVIDENCE_TASKS) {
    test(`${operationId} evidence fits every supported width in the ${theme} theme`, async ({
      page,
      checkA11y,
    }) => {
      await page.addInitScript((selectedTheme) => {
        localStorage.setItem('weft-ui-theme', selectedTheme);
      }, theme);
      for (const viewport of VIEWPORTS) {
        await page.setViewportSize(viewport);
        await openTask(page, operationId);
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

        const label = `${operationId} (${theme}, ${viewport.width}px)`;
        const timeline = page.getByRole('list', { name: 'Attempt history' });
        await expect(timeline).toBeVisible();
        await expect(region(page, 'Lease clocks')).toBeVisible();
        await expect(region(page, 'Cancellation evidence')).toBeVisible();
        await expectNoHorizontalOverflow(region(page, 'Attempt history'), `${label} timeline`);
        await expectNoHorizontalOverflow(region(page, 'Lease clocks'), `${label} lease clocks`);
        await expectNoHorizontalOverflow(
          region(page, 'Cancellation evidence'),
          `${label} cancellation evidence`,
        );
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          `${label} page width`,
        ).toBe(true);
        await checkA11y(label);
      }
    });
  }
}
