/**
 * COR-274: an operator watching a run sees which of its activities were dispatched to a remote
 * worker, and reads the task ledger's record for each from the timeline step.
 *
 * The seeded engine runs its activities in process, so no run here has a real remote dispatch to
 * read (`activityExecution` is engine-wide, and a remote-mode console engine would change every
 * fixture workflow). The spec opens a real seeded run and answers the requests the Timeline tab
 * makes about it (`GET .../timeline`, the pending-activity list, and `weft.tasks.get`) with what a
 * remote-mode engine returns, so the page, its states, and its layout are real and only the data is
 * scripted. The ledger answers for exactly two ids and `NotFound` for every other, so the spec also
 * proves which key the page reads: a settled step by its entry's `taskOperationId`, a running step
 * by its pending activity's `token` (never the pending record's own `operationId`), and a running
 * local async activity, whose token the ledger does not know, offers nothing.
 * `timeline-tab-remote-task.test.ts` covers the same flows against fakes, and Weft's
 * `timeline-task-identity.test.ts` proves the engine writes `taskOperationId`.
 */
import type { Page } from '@playwright/test';

import { expect, test } from './fixtures.ts';

const SETTLED_OPERATION_ID = 'as:e2e-remote-run:0:1';
const RUNNING_TOKEN = 'async-act:v1:e2e-remote-run:1:1';
/** The pending record's own id: the workflow operation's, which names no ledger record. */
const RUNNING_OPERATION_ID = 'e2e-workflow-operation-id';
const LOCAL_ASYNC_TOKEN = 'async-act:v1:e2e-remote-run:3:1';

const T = 1_700_000_000_000;

function activityEntry(step: number, label: string, status: string, extra = {}) {
  return {
    step,
    operationType: 'activity',
    operationLabel: label,
    inputSummary: '{}',
    timestamp: T + step * 1_000,
    status,
    ...extra,
  };
}

const TIMELINE = [
  activityEntry(1, 'chargeCard', 'completed', { taskOperationId: SETTLED_OPERATION_ID }),
  activityEntry(2, 'reserveInventory', 'running'),
  activityEntry(3, 'sendReceipt', 'completed'),
  activityEntry(4, 'approveRefund', 'running'),
];

const PENDING = [
  {
    token: RUNNING_TOKEN,
    operationId: RUNNING_OPERATION_ID,
    activityName: 'reserveInventory',
    step: 2,
    attempt: 1,
    createdAt: T,
  },
  {
    token: LOCAL_ASYNC_TOKEN,
    operationId: 'e2e-local-async-operation-id',
    activityName: 'approveRefund',
    step: 4,
    attempt: 1,
    createdAt: T,
  },
];

const BASE_TASK = {
  workflowId: 'e2e-remote-run',
  workflowExecutionToken: 'e2e-execution-token-0123456789abcdef0123456789abcdef',
  workflowType: 'order-processing',
  queue: 'payments',
  headerKeys: ['traceparent', 'x-tenant-identifier'],
  visibilityTimeoutMilliseconds: 30_000,
  scheduleToCloseDeadline: 4_000_000_000_000,
  retryPolicy: { maxAttempts: 3, initialBackoff: '1s', backoffMultiplier: 2, maxBackoff: '1m' },
  createdAt: T,
  attempts: [],
};

/** A finished dispatch: what the ledger holds for a step that has settled. */
const SETTLED_TASK = {
  ...BASE_TASK,
  state: 'terminal',
  operationId: SETTLED_OPERATION_ID,
  activityName: 'chargeCard',
  attempt: 1,
  disposition: 'resolved',
  terminalAt: T + 2_000,
  adopted: true,
  resultDigest: 'sha256:result',
  resultStatus: 'completed',
};

/** A dispatch still waiting for a worker: what the ledger holds for a running step. */
const RUNNING_TASK = {
  ...BASE_TASK,
  state: 'queued',
  operationId: RUNNING_TOKEN,
  activityName: 'reserveInventory',
  attempt: 2,
  availableAt: T + 30_000,
  firstQueuedAt: T,
  lastQueuedAt: T,
  retryCount: 1,
  requeueCount: 0,
};

const LEDGER: Readonly<Record<string, unknown>> = {
  [SETTLED_OPERATION_ID]: SETTLED_TASK,
  [RUNNING_TOKEN]: RUNNING_TASK,
};

interface Scripted {
  readonly href: string;
  /** Every id the page asked `weft.tasks.get` about. */
  readonly ledgerReads: string[];
}

async function scriptRemoteRun(page: Page): Promise<Scripted> {
  await page.goto('/runs');
  const link = page
    .getByRole('row', { name: /order-processing/ })
    .first()
    .getByRole('link');
  const href = await link.getAttribute('href');
  if (href === null) throw new Error('The seeded run has no link.');

  const ledgerReads: string[] = [];
  await page.route('**/workflows/*/timeline', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(TIMELINE),
    });
  });
  await page.route('**/jsonrpc', async (route) => {
    const body = route.request().postDataJSON() as {
      id?: unknown;
      method?: unknown;
      params?: { operationId?: unknown };
    } | null;
    const reply = (payload: object) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ jsonrpc: '2.0', id: body?.id ?? null, ...payload }),
      });
    if (body?.method === 'weft.workflows.activities.pending.list') {
      await reply({ result: { items: PENDING } });
    } else if (body?.method === 'weft.tasks.get') {
      const operationId = String(body.params?.operationId);
      ledgerReads.push(operationId);
      const record = LEDGER[operationId];
      await reply(
        record === undefined
          ? {
              error: {
                code: -32004,
                message: 'No such task.',
                data: { httpStatus: 404, weftCode: 'NotFound' },
              },
            }
          : { result: record },
      );
    } else {
      await route.continue();
    }
  });
  return { href, ledgerReads };
}

async function openTimeline(page: Page, href: string): Promise<void> {
  await page.goto(href);
  await page.getByRole('tab', { name: 'Timeline' }).click();
  await expect(page.getByText('reserveInventory').first()).toBeVisible();
}

async function openRunningRemoteTask(page: Page, href: string) {
  await openTimeline(page, href);
  const toggle = page.getByRole('button', { name: 'Remote task for reserveInventory' });
  await expect(toggle).toBeVisible();
  await toggle.click();
  const panel = page.getByRole('region', { name: 'Remote task for reserveInventory' });
  await expect(panel.getByText('Queued for a worker')).toBeVisible();
  return panel;
}

test('remote steps, settled and running, show their ledger records, and local steps offer nothing', async ({
  page,
  checkA11y,
}) => {
  const { href, ledgerReads } = await scriptRemoteRun(page);
  await openTimeline(page, href);

  // Only the two remote steps offer a record: not the settled local step, and not the running
  // local async activity, whose token the ledger does not know.
  await expect(page.getByRole('button', { name: 'Remote task for chargeCard' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Remote task for reserveInventory' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /^Remote task for / })).toHaveCount(2);
  await expect(page.getByText('approveRefund').first()).toBeVisible();

  await page.getByRole('button', { name: 'Remote task for chargeCard' }).click();
  const settled = page.getByRole('region', { name: 'Remote task for chargeCard' });
  await expect(settled.getByText('Resolved', { exact: true })).toBeVisible();
  await expect(settled.getByText('payments', { exact: true })).toBeVisible();
  await expect(settled.getByText('1 of 3')).toBeVisible();
  await expect(settled.getByText(/Up to 3 attempts/)).toBeVisible();
  await expect(settled.getByText('traceparent, x-tenant-identifier')).toBeVisible();
  await expect(settled.getByText(BASE_TASK.workflowExecutionToken)).toBeVisible();
  await expect(settled.getByRole('link', { name: 'Open the task ledger record' })).toHaveAttribute(
    'href',
    new RegExp(`task=${encodeURIComponent(SETTLED_OPERATION_ID)}`),
  );

  await page.getByRole('button', { name: 'Remote task for reserveInventory' }).click();
  const running = page.getByRole('region', { name: 'Remote task for reserveInventory' });
  await expect(running.getByText('Queued for a worker')).toBeVisible();
  await expect(running.getByText('2 of 3')).toBeVisible();

  // The page read the ledger by the settled entry's id and the running step's pending token, never
  // by the pending record's own operation id, and asked about the local async token too (and was
  // told there is no record).
  expect(new Set(ledgerReads)).toEqual(
    new Set([SETTLED_OPERATION_ID, RUNNING_TOKEN, LOCAL_ASYNC_TOKEN]),
  );
  expect(ledgerReads).not.toContain(RUNNING_OPERATION_ID);

  await checkA11y('workflow detail — timeline, remote tasks');
});

test('the running remote task panel keeps every value inside its card at supported widths and themes', async ({
  page,
}, testInfo) => {
  const { href } = await scriptRemoteRun(page);

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
      const panel = await openRunningRemoteTask(page, href);
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
