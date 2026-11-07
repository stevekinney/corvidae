/**
 * The Workers page in the states the sample world does not draw (COR-2018, rows 78g to 79i, 78q to
 * 78u, 79a to 79e). The showcase host holds the sample world, where work runs inside Interborough
 * and no worker is connected, so each state is drawn by answering the Weft operations the page reads
 * (`weft.workers.list`, `weft.task.queues.list`, `weft.tasks.diagnostics` and
 * `weft.task.queues.tasks`) as a deployment with remote workers would: Reports worker went quiet an
 * hour before the sample "now", two Payments workers are connected, and Search worker is finishing
 * its tasks. The real operations, against real workers and a real ledger, are in
 * `health-workers.spec.ts`.
 */
import type { Page, Route } from '@playwright/test';

import { SAMPLE_NOW_MILLISECONDS, SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { designReviewCaptureDirectory } from '../../scripts/environment-configuration.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'health-workers-states.spec.ts';
const MINUTE = 60_000;

/** The browser's "now": the sample world's in a capture, the real one otherwise. */
const NOW = designReviewCaptureDirectory() ? SAMPLE_NOW_MILLISECONDS : Date.now();

interface Worker {
  id: string;
  name?: string;
  queue: string;
  inFlight: number;
  health: 'active' | 'draining' | 'drained';
  heardMinutesAgo: number;
  disconnected?: boolean;
  drainFinishedTasks?: number;
  drainedMinutesAgo?: number;
}

interface Task {
  operationId: string;
  status: 'waiting' | 'failed';
  workflowId: string;
  workflowType: string;
  activityName: string;
  attempt: number;
  at: number;
  error?: string;
}

const WORKERS: Worker[] = [
  {
    id: 'reports-worker',
    name: 'Reports worker',
    queue: 'reports',
    inFlight: 0,
    health: 'active',
    heardMinutesAgo: 65,
    disconnected: true,
  },
  {
    id: 'payments-worker-1',
    name: 'Payments worker 1',
    queue: 'payments',
    inFlight: 3,
    health: 'active',
    heardMinutesAgo: 0,
  },
  {
    id: 'payments-worker-2',
    name: 'Payments worker 2',
    queue: 'payments',
    inFlight: 2,
    health: 'active',
    heardMinutesAgo: 0.07,
  },
  {
    id: 'search-worker',
    name: 'Search worker',
    queue: 'search',
    inFlight: 2,
    health: 'draining',
    heardMinutesAgo: 0.15,
  },
];

const FAILED: Task[] = [
  {
    operationId: 'collect-merged-changes',
    status: 'failed',
    workflowId: 'release-notes-run',
    workflowType: 'release-notes',
    activityName: 'collect-merged-changes',
    attempt: 5,
    at: Date.UTC(2026, 9, 30, 20, 0),
    error: 'GitHub didn’t answer (HTTP 503)',
  },
  {
    operationId: 'notify-on-failure',
    status: 'failed',
    workflowId: 'release-notes-run',
    workflowType: 'release-notes',
    activityName: 'notify-on-failure',
    attempt: 5,
    at: Date.UTC(2026, 9, 30, 20, 5),
    error: 'The Slack channel #releases no longer exists.',
  },
];

const waitingTasks = (count: number): Task[] =>
  Array.from({ length: count }, (_, index) => ({
    operationId: `render-digest-${String(index)}`,
    status: 'waiting',
    workflowId: 'release-notes-run',
    workflowType: 'release-notes',
    activityName: 'render-digest',
    attempt: 1,
    at: NOW - (210 - index * 33) * MINUTE,
  }));

/** What the page reads, and what it changes. */
interface Fleet {
  workers: Worker[];
  failed: Task[];
  waiting: Task[];
  /** How many tasks one page of the tasks list returns; the page asks for more with Load more. */
  pageSize: number;
  /** Retry requests are held until `release` is called, for the moment the buttons read "Retrying 2…". */
  holdRetries: boolean;
  releases: (() => void)[];
  cleared: string[];
  retried: string[];
}

function newFleet(overrides: Partial<Fleet> = {}): Fleet {
  return {
    workers: WORKERS,
    failed: FAILED,
    waiting: waitingTasks(12),
    pageSize: 25,
    holdRetries: false,
    releases: [],
    cleared: [],
    retried: [],
    ...overrides,
  };
}

function summaryOf(worker: Worker) {
  return {
    id: worker.id,
    ...(worker.name === undefined ? {} : { name: worker.name }),
    queue: worker.queue,
    transport: 'websocket',
    activities: [],
    concurrency: 4,
    inFlight: worker.inFlight,
    availableCapacity: 4 - worker.inFlight,
    connectedAt: NOW - 600 * MINUTE,
    lastHeartbeatAt: NOW - worker.heardMinutesAgo * MINUTE,
    heartbeatAgeMs: worker.heardMinutesAgo * MINUTE,
    startedAt: NOW - 600 * MINUTE,
    capabilities: {},
    health: worker.health,
    workflows: ['release-notes'],
    buildId: '2.4.1',
    ...(worker.disconnected === true ? { disconnectedAt: NOW - 64 * MINUTE } : {}),
    ...(worker.drainFinishedTasks === undefined
      ? {}
      : { drainFinishedTasks: worker.drainFinishedTasks }),
    ...(worker.drainedMinutesAgo === undefined
      ? {}
      : { drainedAt: NOW - worker.drainedMinutesAgo * MINUTE }),
  };
}

/** The answer to one Weft operation, or `undefined` to leave it to the host. */
function answer(fleet: Fleet, method: string, params: Record<string, unknown>): unknown {
  const tasksOn = (queue: unknown, status: unknown): Task[] => {
    if (queue !== 'reports') return [];
    return status === 'failed'
      ? fleet.failed
      : status === 'waiting'
        ? fleet.waiting
        : [...fleet.failed, ...fleet.waiting];
  };
  switch (method) {
    case 'weft.workers.list':
      return {
        items: fleet.workers.map(summaryOf),
        deployments: [],
        routingPolicy: 'least-loaded',
      };
    case 'weft.task.queues.list':
      return {
        items: [
          {
            queue: 'reports',
            backlog: fleet.waiting.length,
            oldestEnqueuedAt: null,
            oldestQueuedAgeMs: null,
            waitingPollers: 0,
            schedulingPolicy: 'priority',
            inFlight: 0,
            connectedWorkers: 0,
          },
        ],
      };
    case 'weft.tasks.diagnostics':
      return {
        items: [],
        limit: 50,
        summary: {
          stuckQueued: 0,
          staleInflight: 0,
          retryStorms: 0,
          allWorkersAtCapacity: 0,
          deadLettered: fleet.failed.length,
          delayed: 0,
          unadoptedTerminal: 0,
        },
      };
    case 'weft.task.queues.tasks': {
      const all = tasksOn(params['queue'], params['status']);
      const start = typeof params['cursor'] === 'string' ? Number(params['cursor']) : 0;
      const page = all.slice(start, start + fleet.pageSize);
      return {
        queue: params['queue'],
        counts: {
          waiting: params['queue'] === 'reports' ? fleet.waiting.length : 0,
          failed: params['queue'] === 'reports' ? fleet.failed.length : 0,
        },
        items: page,
        nextCursor: start + fleet.pageSize < all.length ? String(start + fleet.pageSize) : null,
      };
    }
    case 'weft.workers.rejections':
      return { items: [], limit: 25 };
    case 'weft.workers.diagnostics':
      return { worker: null };
    case 'weft.tasks.deadletters.retry':
      fleet.retried.push(String(params['operationId']));
      return { operationId: params['operationId'], state: 'queued', attempt: 6, requeueCount: 1 };
    case 'weft.tasks.deadletters.get':
      return {
        operationId: params['operationId'],
        attempt: 5,
        attemptTokenDigest: 'digest',
        pendingStatus: 'failed',
        resultDigest: 'sha256:result',
        deadLetteredAt: FAILED[0]?.at ?? 0,
        persistenceFailureReason: 'storage',
        payload: {
          kind: 'value',
          value: { repository: 'stevekinney/interborough', release: 'v2.4.1' },
          serializedBytes: 60,
        },
      };
    default:
      return undefined;
  }
}

/** Answers the Weft operations the page reads with `fleet`, and lets the host answer the rest. */
async function answerFleet(page: Page, fleet: Fleet): Promise<void> {
  await page.route('**/jsonrpc', async (route: Route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as {
      id?: unknown;
      method?: string;
      params?: Record<string, unknown>;
    };
    const method = body.method ?? '';
    if (method === 'weft.tasks.deadletters.retry' && fleet.holdRetries) {
      await new Promise<void>((resolve) => {
        fleet.releases.push(resolve);
      });
    }
    const result = answer(fleet, method, body.params ?? {});
    if (result === undefined) {
      await route.fallback();
      return;
    }
    await route.fulfill({ json: { jsonrpc: '2.0', id: body.id ?? 1, result } });
  });
  await page.route('**/v1/tasks/diagnostics/dead-letter/*', async (route) => {
    fleet.cleared.push(route.request().url().split('/').at(-1) ?? '');
    await route.fulfill({ status: 204 });
  });
}

const detail = (page: Page) => page.getByTestId('worker-detail');
const rows = (page: Page) => page.locator('[data-worker-row]');

test('a deployment with remote workers: the list, the open worker, its notice, facts and failed tasks', async ({
  page,
  checkA11y,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const fleet = newFleet();
  await answerFleet(page, fleet);
  await page.goto('/health/workers?worker=reports-worker');

  // 78g, 78h: Health's header with Workers active, the list titled Workers, one line of counts.
  await expect(page.getByRole('heading', { level: 1, name: 'Health' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Workers', exact: true })).toBeVisible();
  await expect(page.getByTestId('workers-summary')).toHaveText(
    '3 of 4 connected · 7 running · 12 waiting · 2 failed for good',
  );
  await expect(page.getByRole('searchbox', { name: 'Filter workers' })).toBeVisible();

  // 78i, 78j: status-first rows, the open one tinted; the disconnected worker leads.
  await expect(rows(page)).toHaveCount(4);
  await expect(rows(page).nth(0)).toContainText('Disconnected');
  await expect(rows(page).nth(0)).toContainText('Reports worker');
  await expect(rows(page).nth(0)).toContainText('reports queue');
  await expect(rows(page).nth(1)).toContainText('Payments worker 1');
  await expect(rows(page).nth(1)).toContainText('payments · 3 running');
  await expect(rows(page).nth(3)).toContainText('Finishing 2 tasks, then stops');
  await expect(rows(page).nth(0).locator('[aria-current]').first()).toBeVisible();

  // 78k: the header, its status line and its one action.
  await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText('Reports worker');
  await expect(detail(page).getByTestId('worker-id')).toHaveText('reports-worker');
  await expect(detail(page).getByTestId('worker-status-line')).toContainText(
    'Last heard from an hour ago',
  );
  await expect(detail(page).getByRole('button', { name: 'Forget this worker' })).toBeVisible();
  await expect(detail(page).getByRole('button', { name: 'Drain this worker' })).toHaveCount(0);

  // 78l: the amber notice.
  const notice = page.getByTestId('worker-notice');
  await expect(notice).toContainText('Nothing is running the reports queue.');
  await expect(notice).toContainText('12 tasks are waiting for it and 2 failed for good.');

  // 78m: the facts row.
  const facts = page.getByTestId('worker-facts');
  await expect(facts.locator('dt')).toHaveText(['Queues', 'Running now', 'Serves', 'Version']);
  await expect(facts.locator('dd')).toHaveText(['reports', '0 tasks', 'Release notes', '2.4.1']);

  // 78n to 78p: the tasks on the queue, Failed for good selected, the bulk buttons, the rows.
  const tasks = page.getByTestId('worker-tasks');
  await expect(tasks.getByRole('heading', { name: 'Tasks on the reports queue' })).toBeVisible();
  await expect(tasks.getByRole('radio', { name: /Failed for good/ })).toBeChecked();
  await expect(tasks.getByRole('radio', { name: /All/ })).toContainText('14');
  await expect(tasks.getByRole('button', { name: 'Retry all (2)' })).toBeVisible();
  await expect(tasks.getByRole('button', { name: 'Clear all (2)' })).toBeVisible();
  const first = tasks.locator('[data-task="collect-merged-changes"]');
  await expect(first).toContainText('Failed for good');
  await expect(first.locator('code')).toHaveText('collect-merged-changes');
  await expect(first.getByRole('link', { name: 'Release notes run' })).toBeVisible();
  await expect(first).toContainText('Failed after 5 tries · GitHub didn’t answer (HTTP 503).');
  await expect(first.getByRole('button', { name: 'View payload' })).toBeVisible();
  await expect(first.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(first.getByRole('button', { name: 'Clear' })).toBeVisible();
  await expect(tasks.getByText(/Retry puts a task back on the queue/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await captureForDesignReview(page, {
    route: '/health/workers',
    state: 'remote-workers',
    source: SOURCE,
  });
  await checkA11y('workers—a deployment with remote workers');

  // View payload opens the payload inspector.
  await first.getByRole('button', { name: 'View payload' }).click();
  const payload = page.getByRole('dialog', { name: 'Payload of collect-merged-changes' });
  await expect(payload.getByText('stevekinney/interborough')).toBeVisible();
  await captureForDesignReview(page, {
    route: '/health/workers',
    state: 'payload',
    source: SOURCE,
  });
  await payload.getByRole('button', { name: /close/i }).click();
  await expect(payload).toBeHidden();
});

test('Drain asks first, saying what happens to the running and waiting work', async ({
  page,
  checkA11y,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await answerFleet(page, newFleet());
  await page.goto('/health/workers?worker=payments-worker-1');

  // 78w: a connected worker's header.
  await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText('Payments worker 1');
  await expect(detail(page).getByTestId('worker-id')).toHaveText('payments-worker-1');
  await expect(detail(page).getByTestId('worker-status-line')).toHaveText(
    'Last heard from just now',
  );
  await expect(page.getByTestId('worker-notice')).toHaveCount(0);

  // 78q, 78s: a confirm dialog with a primary button.
  await detail(page).getByRole('button', { name: 'Drain this worker' }).click();
  const dialog = page.getByRole('dialog', { name: 'Drain Payments worker 1?' });
  await expect(dialog).toContainText(
    'It finishes the 3 tasks it is running, takes no new ones, and then stops. New payments tasks go to Payments worker 2.',
  );
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Drain worker' })).toBeVisible();
  await captureForDesignReview(page, {
    route: '/health/workers',
    state: 'confirm-drain',
    source: SOURCE,
  });
  await checkA11y('workers—drain confirmation');
});

test('Forget asks first, saying the waiting and failed tasks stay on the queue', async ({
  page,
  checkA11y,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await answerFleet(page, newFleet());
  await page.goto('/health/workers?worker=reports-worker');

  await detail(page).getByRole('button', { name: 'Forget this worker' }).click();
  const dialog = page.getByRole('dialog', { name: 'Forget Reports worker?' });
  await expect(dialog).toContainText(
    'Interborough stops listing it. The 12 waiting tasks and the 2 that failed for good stay on the reports queue and continue when a reports worker connects. If the worker is still running, it shows up again the next time it checks in.',
  );
  await expect(dialog.getByRole('button', { name: 'Forget worker' })).toBeVisible();
  await captureForDesignReview(page, {
    route: '/health/workers',
    state: 'confirm-forget',
    source: SOURCE,
  });
  await checkA11y('workers—forget confirmation');
});

test('Clear all holds the tasks for an Undo toast, and sends nothing until the page is left', async ({
  page,
  checkA11y,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const fleet = newFleet();
  await answerFleet(page, fleet);
  await page.goto('/health/workers?worker=reports-worker');

  await page.getByRole('button', { name: 'Clear all (2)' }).click();

  // 78u: the centred line and the dark toast with Undo, which has no close button.
  const tasks = page.getByTestId('worker-tasks');
  await expect(tasks.getByTestId('worker-tasks-empty')).toHaveText(
    'No failed tasks. 12 are still waiting.',
  );
  const toast = page.getByText('Cleared 2 failed tasks from the reports queue.');
  await expect(toast).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();
  expect(fleet.cleared).toEqual([]);
  // The counts follow the held clear: no failed tasks to retry or clear, the waiting ones stay (78u).
  await expect(page.getByRole('radio', { name: /^Failed for good/ })).toContainText('0');
  await expect(page.getByRole('button', { name: /^Retry all/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Clear all/ })).toHaveCount(0);
  await captureForDesignReview(page, {
    route: '/health/workers',
    state: 'cleared',
    source: SOURCE,
  });
  await checkA11y('workers—after Clear all');

  // Undo puts them back, and nothing was sent.
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(tasks.locator('[data-task="collect-merged-changes"]')).toBeVisible();
  expect(fleet.cleared).toEqual([]);
});

test('Retry all needs no confirmation: the tasks wait again at once and a toast says so', async ({
  page,
  checkA11y,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const fleet = newFleet({ holdRetries: true });
  await answerFleet(page, fleet);
  await page.goto('/health/workers?worker=reports-worker');

  await page.getByRole('button', { name: 'Retry all (2)' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // 79d: both buttons disabled, the tasks Waiting on their next try.
  await expect(page.getByRole('button', { name: 'Retrying 2…' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Clear all (2)' })).toBeDisabled();
  const first = page.locator('[data-task="collect-merged-changes"]');
  await expect(first).toContainText('Waiting');
  await expect(first).toContainText('Back on the queue · try 6');
  await expect(first).toContainText('Oct 30');
  await captureForDesignReview(page, {
    route: '/health/workers',
    state: 'retrying',
    source: SOURCE,
  });

  // 79e: a toast that offers no Undo.
  await expect.poll(() => fleet.releases.length).toBe(2);
  fleet.holdRetries = false;
  fleet.failed = [];
  fleet.waiting = [...waitingTasks(12)];
  for (const release of fleet.releases) release();
  const toast = page.getByText(
    'Put 2 tasks back on the reports queue. They run when a reports worker connects.',
  );
  await expect(toast).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo' })).toHaveCount(0);
  await captureForDesignReview(page, {
    route: '/health/workers',
    state: 'retried',
    source: SOURCE,
  });
  await checkA11y('workers—after Retry all');
  expect(fleet.retried.toSorted()).toEqual(['collect-merged-changes', 'notify-on-failure']);
});

test('a filter that matches nothing keeps the text and the open worker', async ({
  page,
  checkA11y,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await answerFleet(page, newFleet());
  await page.goto('/health/workers?worker=reports-worker');

  const field = page.getByRole('searchbox', { name: 'Filter workers' });
  await field.fill('billing');

  // 79a.
  await expect(field).toHaveValue('billing');
  await expect(page.getByRole('heading', { name: 'No workers match “billing”' })).toBeVisible();
  await expect(page.getByText('Workers are matched by name and queue.')).toBeVisible();
  await expect(page.getByTestId('workers-summary')).toHaveText(
    '3 of 4 connected · 7 running · 12 waiting · 2 failed for good',
  );
  await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText('Reports worker');
  await captureForDesignReview(page, {
    route: '/health/workers',
    state: 'filter-no-match',
    source: SOURCE,
  });
  await checkA11y('workers—a filter that matches nothing');

  await page.getByRole('button', { name: 'Clear filter' }).click();
  await expect(rows(page)).toHaveCount(4);
});

test('the Waiting tab lists tasks in arrival order, a page at a time', async ({
  page,
  checkA11y,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await answerFleet(page, newFleet({ pageSize: 3 }));
  await page.goto('/health/workers?worker=reports-worker');

  const tasks = page.getByTestId('worker-tasks');
  await tasks.getByRole('radio', { name: /Waiting/ }).click();

  // 79b, 79c.
  const waiting = tasks.locator('li[data-word="Waiting"]');
  await expect(waiting).toHaveCount(3);
  await expect(waiting.first()).toContainText('render-digest');
  await expect(waiting.first()).toContainText(
    'On the reports queue · waiting for a reports worker',
  );
  await expect(tasks.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
  await expect(tasks.getByText('Showing 3 of 12 waiting tasks')).toBeVisible();
  // The count is at the start of the footer and Load more at the end of it (79c).
  const count = await tasks.getByText('Showing 3 of 12 waiting tasks').boundingBox();
  const more = await tasks.getByRole('button', { name: 'Load more' }).boundingBox();
  expect(count?.x ?? 1e9).toBeLessThan(more?.x ?? 0);
  expect(Math.abs((count?.y ?? 0) - (more?.y ?? 1e9))).toBeLessThan(40);
  const card = await tasks.boundingBox();
  expect((more?.x ?? 0) + (more?.width ?? 0)).toBeGreaterThan((card?.width ?? 0) * 0.8);
  await captureForDesignReview(page, {
    route: '/health/workers',
    state: 'waiting-tab',
    source: SOURCE,
  });
  await checkA11y('workers—the Waiting tab');

  await tasks.getByRole('button', { name: 'Load more' }).click();
  await expect(waiting).toHaveCount(6);
});

test('a long id wraps in the header with a Copy button, and the list cuts it from the middle', async ({
  page,
  checkA11y,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const id = 'payments-worker-eu-west-1b-7f3a9c2e-4d81-4b06-a9e2-1c5d0f7b3a68';
  await answerFleet(
    page,
    newFleet({
      workers: [
        {
          id,
          name: 'Payments worker EU',
          queue: 'payments',
          inFlight: 1,
          health: 'active',
          heardMinutesAgo: 0,
        },
      ],
    }),
  );
  await page.goto(`/health/workers?worker=${id}`);

  // 79f, 79g.
  await expect(rows(page).first()).toContainText('payments-worker-eu-w…3a68');
  await expect(rows(page).first()).toContainText('payments · 1 running');
  await expect(detail(page).getByRole('heading', { level: 2 })).toHaveText('Payments worker EU');
  await expect(detail(page).getByTestId('worker-id')).toHaveText(id);
  await expect(detail(page).getByRole('button', { name: 'Copy the worker ID' })).toBeVisible();
  // Copy sits beside the id, not on a line of its own under it (79g).
  const idBox = await detail(page).getByTestId('worker-id').boundingBox();
  const copyBox = await detail(page)
    .getByRole('button', { name: 'Copy the worker ID' })
    .boundingBox();
  expect((copyBox?.x ?? 0) >= (idBox?.x ?? 0) + (idBox?.width ?? 0) - 1).toBe(true);
  expect((copyBox?.y ?? 1e9) < (idBox?.y ?? 0) + (idBox?.height ?? 0)).toBe(true);
  await expect(detail(page).getByTestId('worker-status-line')).toHaveText(
    'Last heard from just now',
  );
  await captureForDesignReview(page, {
    route: '/health/workers',
    state: 'long-id',
    source: SOURCE,
  });
  await checkA11y('workers—a long worker id');
});

test('a worker whose drain has finished reads Stopped, with Forget as its only action', async ({
  page,
  checkA11y,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const fleet = newFleet({
    workers: [
      {
        id: 'search-worker',
        name: 'Search worker',
        queue: 'search',
        inFlight: 0,
        health: 'drained',
        heardMinutesAgo: 0.07,
        drainFinishedTasks: 2,
        drainedMinutesAgo: 0.07,
      },
    ],
  });
  await answerFleet(page, fleet);
  await page.goto('/health/workers?worker=search-worker');

  // 79h, 79i: the row reads Stopped, with a neutral dot (never Disconnected's amber), the worker's
  // name, the seconds since it finished and line two's sentence about its tasks.
  const stopped = rows(page).first();
  await expect(stopped).toContainText('Stopped');
  await expect(stopped).toContainText('Search worker');
  // The seconds follow the clock of the run; a capture pins it at 4 s.
  await expect(stopped).toContainText(/\b\d+ s ago\b/);
  await expect(stopped).toContainText('Drained · finished its 2 tasks');
  await expect(stopped).not.toContainText('Disconnected');
  await expect(stopped.locator('.cinder-status-dot').first()).toHaveAttribute(
    'data-cinder-status',
    'neutral',
  );
  await expect(detail(page).getByTestId('worker-status-line')).toHaveText(
    'It finished its 2 tasks and stopped. Nothing is waiting on it.',
  );
  await expect(detail(page).getByRole('button', { name: 'Forget this worker' })).toBeVisible();
  await expect(detail(page).getByRole('button', { name: /Drain|Resume/ })).toHaveCount(0);
  await captureForDesignReview(page, {
    route: '/health/workers',
    state: 'stopped',
    source: SOURCE,
  });
  await checkA11y('workers—a stopped worker');

  // 79h: it leaves the list the next time the page loads without it, not while the page is open.
  fleet.workers = [];
  await page.reload();
  await expect(rows(page)).toHaveCount(0);
});

test('below the push width one pane shows at a time, with a Back button', async ({
  page,
  checkA11y,
}) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await answerFleet(page, newFleet());
  await page.goto('/health/workers');

  // 78r: the list alone.
  await expect(rows(page)).toHaveCount(4);
  await expect(page.getByTestId('worker-detail')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await captureForDesignReview(page, {
    route: '/health/workers',
    state: 'phone-list',
    source: SOURCE,
  });
  await checkA11y('workers—the list on a phone');

  await rows(page).first().getByRole('link').click();
  await expect(detail(page)).toBeVisible();
  await expect(rows(page)).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await captureForDesignReview(page, {
    route: '/health/workers',
    state: 'phone-detail',
    source: SOURCE,
  });
  await checkA11y('workers—a worker on a phone');

  await page.getByRole('button', { name: 'Back' }).click();
  await expect(rows(page)).toHaveCount(4);
});

const STATE_WIDTHS = [1280, 375] as const;

/** The region the page draws below its heading while it has no worker to list. */
const stateRegion = (page: Page) => page.getByTestId('workers-state');

/** Holds the read of the workers until `release` is called, answering the rest as the host does. */
async function holdWorkersRead(page: Page): Promise<{ release: () => void }> {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/jsonrpc', async (route: Route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { method?: string };
    if (body.method !== 'weft.workers.list') {
      await route.fallback();
      return;
    }
    await gate;
    await route.fallback();
  });
  return { release };
}

for (const width of STATE_WIDTHS) {
  test(`the sample world draws the empty state: where work runs and how to connect a worker, at ${width} pixels`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/health/workers');
    const region = stateRegion(page);

    // 78a, 78b: Health's header with Workers active; the shell's own rows are `shell-chrome.spec.ts`.
    await expect(page.getByRole('heading', { level: 1, name: 'Health' })).toBeVisible();
    if (width >= 640) {
      await expect(page.getByRole('tab', { name: 'Workers', selected: true })).toBeVisible();
    } else {
      await expect(page.locator('.cinder-tabs__collapse')).toContainText('Section: Workers');
    }
    // 78c: one line under the section heading.
    await expect(region).toHaveAttribute('data-state', 'empty');
    await expect(region.getByRole('heading', { level: 2, name: 'Workers' })).toBeVisible();
    await expect(page.getByTestId('workers-summary')).toHaveText(
      'Work runs inside Interborough · 0 running · 0 waiting',
    );
    // 78d: an empty state in a bordered card, with one secondary button that opens the guide.
    const card = region.locator('.cinder-empty-state');
    await expect(card).toHaveAttribute('data-cinder-bordered', '');
    await expect(card.getByRole('heading', { name: 'No workers connected' })).toBeVisible();
    await expect(
      card.getByText('Work runs inside Interborough. Connect a worker to run it elsewhere.'),
    ).toBeVisible();
    const guide = card.getByRole('link', { name: 'How to connect a worker' });
    await expect(guide).toHaveAttribute('data-cinder-variant', 'secondary');
    await expect(guide).toHaveAttribute('target', '_blank');
    await expect(card.getByRole('button')).toHaveCount(0);
    // 78e: no worker row, no status word, no amber or red tone.
    await expect(page.locator('[data-worker-row], [data-status-word]')).toHaveCount(0);
    await expect(region.locator('[role="alert"], .cinder-banner')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );

    await captureForDesignReview(page, {
      route: '/health/workers',
      state: 'empty',
      source: SOURCE,
    });
    await checkA11y(`workers—the empty state at ${width}px`);

    // 78e: nothing on the page counts toward Needs attention, which lists no worker.
    await page.goto('/health');
    await expect(page.getByTestId('needs-attention')).toBeVisible();
    await expect(page.locator('[data-attention^="worker-"]')).toHaveCount(0);
  });

  test(`while the workers are read: real text at once, four rows after 300 ms, Still loading with Cancel after 10 s, at ${width} pixels`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.clock.install();
    const held = await holdWorkersRead(page);
    await page.goto('/health/workers');
    const region = stateRegion(page);

    // 78x: the heading and the line are text from the first paint; nothing else for 300 ms.
    await expect(region).toHaveAttribute('data-state', 'loading');
    await expect(region.getByRole('heading', { level: 2, name: 'Workers' })).toBeVisible();
    await expect(region.getByText('Loading workers…')).toBeVisible();
    await expect(region.locator('.cinder-skeleton-row')).toHaveCount(0);
    await page.clock.runFor(300);
    await expect(region.locator('.cinder-skeleton-row')).toHaveCount(4);
    await expect(
      region.locator('.cinder-skeleton-status-bar[data-cinder-marker="dot"]'),
    ).toHaveCount(4);
    await captureForDesignReview(page, {
      route: '/health/workers',
      state: 'loading',
      source: SOURCE,
    });
    await checkA11y(`workers—loading at ${width}px`);

    // 78y: after 10 s Cinder's own line and a ghost Cancel, not a banner.
    await page.clock.runFor(10_000);
    await expect(
      region.getByText('Still loading. This is taking longer than usual.'),
    ).toBeVisible();
    await expect(region.getByRole('button', { name: 'Cancel' })).toHaveAttribute(
      'data-cinder-variant',
      'ghost',
    );
    await expect(page.locator('.cinder-banner')).toHaveCount(0);
    await captureForDesignReview(page, {
      route: '/health/workers',
      state: 'loading-slow',
      source: SOURCE,
    });

    // Cancel stops the read and says so; Try again reads again.
    await region.getByRole('button', { name: 'Cancel' }).click();
    await expect(region).toHaveAttribute('data-state', 'cancelled');
    held.release();
    await region.getByRole('button', { name: 'Try again' }).click();
    await expect(region).toHaveAttribute('data-state', 'empty');
  });

  test(`a failed read is the error state in the Workers section, with Try again and Open Health, at ${width} pixels`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    // An answer of 500 is asked again with a back-off before the read gives up, and the clock runs
    // the waits in moments.
    await page.clock.install();
    let failing = true;
    await page.route('**/jsonrpc', async (route: Route) => {
      const body = JSON.parse(route.request().postData() ?? '{}') as {
        id?: unknown;
        method?: string;
      };
      if (!failing || body.method !== 'weft.workers.list') {
        await route.fallback();
        return;
      }
      await route.fulfill({
        json: {
          jsonrpc: '2.0',
          id: body.id ?? 1,
          error: {
            code: -32000,
            message: 'The engine broke.',
            data: { httpStatus: 500, weftCode: 'EngineFailure' },
          },
        },
      });
    });
    await page.goto('/health/workers');
    const region = stateRegion(page);
    await expect(async () => {
      await page.clock.runFor(10_000);
      // load-proof: a miss only runs the fake clock further and tries again, so a slow host adds attempts, never a failure.
      await expect(region).toHaveAttribute('data-state', 'failed', { timeout: 1_000 });
    }).toPass();

    // 78z: a red disc with a warning glyph, the status named, and no banner beside it.
    await expect(region.getByRole('heading', { level: 2, name: 'Workers' })).toBeVisible();
    await expect(
      region.getByRole('heading', { level: 3, name: 'Couldn’t load workers' }),
    ).toBeVisible();
    await expect(
      region.getByText(
        'The server answered with an error (500). Nothing you did caused it. Workers keep running while this page is down.',
      ),
    ).toBeVisible();
    await expect(region.locator('.cinder-error-state[data-cinder-tone="danger"]')).toHaveAttribute(
      'data-cinder-bordered',
      '',
    );
    await expect(region.getByRole('button', { name: 'Try again' })).toHaveAttribute(
      'data-cinder-variant',
      'secondary',
    );
    await expect(region.getByRole('link', { name: 'Open Health' })).toHaveAttribute(
      'data-cinder-variant',
      'link',
    );
    await expect(page.locator('.cinder-banner')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );

    await captureForDesignReview(page, {
      route: '/health/workers',
      state: 'error',
      source: SOURCE,
    });
    await checkA11y(`workers—a failed read at ${width}px`);

    // Open Health goes to the Overview; Try again reads again once the server answers.
    failing = false;
    await region.getByRole('button', { name: 'Try again' }).click();
    await expect(region).toHaveAttribute('data-state', 'empty');
  });
}
