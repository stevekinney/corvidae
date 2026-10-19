/**
 * COR-274: an operator watching a run sees which of its activities were dispatched to a remote
 * worker, and reads the task ledger's record for each from the timeline step.
 *
 * The seeded engine runs its activities in process, so no run here has a real remote dispatch to
 * read. The spec opens a real seeded run and answers the two requests the Timeline tab makes
 * about it (`GET .../timeline` and `weft.tasks.get`) with the entries and record a remote-mode
 * engine would return, so the page, its states, and its layout are real and only the data is
 * scripted. `timeline-tab-remote-task.test.ts` covers the same flows against fakes, and
 * `timeline-task-identity.test.ts` in Weft proves the engine writes `taskOperationId`.
 */
import type { Page } from '@playwright/test';

import { expect, test } from './fixtures.ts';

const REMOTE_OPERATION_ID = 'as:e2e-remote-run:2:1';

const T = 1_700_000_000_000;

const TIMELINE = [
  {
    step: 1,
    operationType: 'activity',
    operationLabel: 'chargeCard',
    inputSummary: '{}',
    timestamp: T,
    status: 'completed',
    taskOperationId: REMOTE_OPERATION_ID,
  },
  {
    step: 2,
    operationType: 'activity',
    operationLabel: 'reserveInventory',
    inputSummary: '{}',
    timestamp: T + 1_000,
    status: 'completed',
  },
];

const TASK = {
  state: 'queued',
  operationId: REMOTE_OPERATION_ID,
  workflowId: 'e2e-remote-run',
  workflowExecutionToken: 'e2e-execution-token-0123456789abcdef0123456789abcdef',
  workflowType: 'order-processing',
  activityName: 'chargeCard',
  queue: 'payments',
  headerKeys: ['traceparent', 'x-tenant-identifier'],
  visibilityTimeoutMilliseconds: 30_000,
  scheduleToCloseDeadline: 4_000_000_000_000,
  retryPolicy: { maxAttempts: 3, initialBackoff: '1s', backoffMultiplier: 2, maxBackoff: '1m' },
  createdAt: T,
  attempt: 2,
  availableAt: T + 30_000,
  firstQueuedAt: T,
  lastQueuedAt: T,
  retryCount: 1,
  requeueCount: 0,
  attempts: [],
};

async function scriptRemoteRun(page: Page): Promise<string> {
  await page.goto('/runs');
  const link = page
    .getByRole('row', { name: /order-processing/ })
    .first()
    .getByRole('link');
  const href = await link.getAttribute('href');
  if (href === null) throw new Error('The seeded run has no link.');

  await page.route('**/workflows/*/timeline', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(TIMELINE),
    });
  });
  await page.route('**/jsonrpc', async (route) => {
    const body = route.request().postDataJSON() as { id?: unknown; method?: unknown } | null;
    if (body?.method !== 'weft.tasks.get') {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jsonrpc: '2.0', id: body.id ?? null, result: TASK }),
    });
  });
  return href;
}

async function openRemoteTask(page: Page, href: string) {
  await page.goto(href);
  await page.getByRole('tab', { name: 'Timeline' }).click();
  const toggle = page.getByRole('button', { name: 'Remote task for chargeCard' });
  await expect(toggle).toBeVisible();
  await toggle.click();
  const panel = page.getByRole('region', { name: 'Remote task for chargeCard' });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('Queued for a worker')).toBeVisible();
  return panel;
}

test('a remote activity step shows its ledger record, and a local one offers nothing', async ({
  page,
  checkA11y,
}) => {
  const href = await scriptRemoteRun(page);
  await page.goto(href);
  await page.getByRole('tab', { name: 'Timeline' }).click();
  await expect(page.getByText('reserveInventory').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^Remote task for / })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Remote task for reserveInventory' })).toHaveCount(
    0,
  );

  const panel = await openRemoteTask(page, href);
  await expect(panel.getByText('payments', { exact: true })).toBeVisible();
  await expect(panel.getByText('2 of 3')).toBeVisible();
  await expect(panel.getByText(/Up to 3 attempts/)).toBeVisible();
  await expect(panel.getByText('traceparent, x-tenant-identifier')).toBeVisible();
  await expect(panel.getByText(TASK.workflowExecutionToken)).toBeVisible();
  await expect(panel.getByRole('link', { name: 'Open the task ledger record' })).toHaveAttribute(
    'href',
    new RegExp(`task=${encodeURIComponent(REMOTE_OPERATION_ID)}`),
  );

  await checkA11y('workflow detail — timeline, remote task');
});

test('the remote task panel keeps every value inside its card at supported widths and themes', async ({
  page,
}, testInfo) => {
  const href = await scriptRemoteRun(page);

  for (const theme of ['light', 'dark'] as const) {
    for (const viewport of [
      { width: 375, height: 812 },
      { width: 768, height: 1024 },
      { width: 1280, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      await page.addInitScript((selectedTheme) => {
        localStorage.setItem('weft-ui-theme', selectedTheme);
      }, theme);
      const panel = await openRemoteTask(page, href);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);

      const box = await panel.boundingBox();
      if (box === null) throw new Error('The remote task panel has no box.');
      const overflowing = await panel.locator('dt, dd').evaluateAll(
        (elements, bounds) =>
          elements
            .filter((element) => {
              const rect = element.getBoundingClientRect();
              return (
                rect.right > bounds.right + 0.5 ||
                rect.left < bounds.left - 0.5 ||
                element.scrollWidth > element.clientWidth + 1
              );
            })
            .map((element) => element.textContent),
        { left: box.x, right: box.x + box.width },
      );
      expect(overflowing).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await panel.screenshot({
        path: testInfo.outputPath(`remote-task-${theme}-${viewport.width}.png`),
      });
    }
  }
});
