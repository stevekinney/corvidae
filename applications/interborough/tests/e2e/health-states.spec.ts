/**
 * The Health Overview in the states the sample world does not draw (COR-2018, rows 76t to 76y,
 * 77a, 77c and 77l): all clear, a first read in progress, and the problems a deployment can have
 * that the sample world has not (a remote worker that stopped answering, a hook whose last delivery
 * failed or that gave up, a plugin that did not load). The showcase host holds the sample world,
 * so each state is drawn by answering the Bureau's `bureau.health.attention` (and, for all clear,
 * the reviews that wait) differently, which is also what the page and the sidebar read.
 *
 * The timings the placeholders keep (nothing for the first 300 ms) are proved with fake timers in
 * `src/routes/health/health-page.test.ts`; here the loading frame is read once the 300 ms have
 * gone, waiting on the skeleton itself and never on a sleep.
 */
import type { Page } from '@playwright/test';

import { SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { SAMPLE_WORLD_THREADS } from '../../fixtures/sample-world-records.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'health-states.spec.ts';
const WIDTHS = [1280, 375] as const;

/** The problems `bureau.health.attention` lists, as the page reads them. */
interface AttentionAnswer {
  items: { kind: string; area: string; at: number | null }[];
  count: number;
  checks: { area: string; count: number }[];
}

/** The areas a check counts, in the order the Bureau lists them. */
const AREAS = ['storage', 'schedules', 'providers', 'hooks', 'plugins', 'workers', 'runs'] as const;

/** The sample world's "now" in Central time (UTC−6), at a clock time today. */
const today = (hour: number, minute: number): number => Date.UTC(2026, 10, 2, hour + 6, minute);

/** The Bureau's order: most recent first, a problem with no known time first. */
function listed(items: AttentionAnswer['items']): AttentionAnswer {
  const ordered = items.toSorted((left, right) => (right.at ?? Infinity) - (left.at ?? Infinity));
  // The checks list the areas in the Bureau's own order, not the order the problems turn up in.
  const areas = AREAS.filter((area) => ordered.some((item) => item.area === area));
  return {
    items: ordered,
    count: ordered.length,
    checks: areas.map((area) => ({
      area,
      count: ordered.filter((item) => item.area === area).length,
    })),
  };
}

/** Answers every read of what needs attention with `change` applied to what the host says. */
async function answerAttention(
  page: Page,
  change: (answer: AttentionAnswer) => AttentionAnswer,
): Promise<void> {
  await page.route('**/bureau/jsonrpc', async (route) => {
    if (!(route.request().postData() ?? '').includes('"bureau.health.attention"')) {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const body = (await response.json()) as { result: AttentionAnswer };
    body.result = change(body.result);
    await route.fulfill({ response, json: body });
  });
}

/** Answers every read of the reviews that wait with none. */
async function answerNoReviews(page: Page): Promise<void> {
  await page.route('**/bureau/jsonrpc', async (route) => {
    if (!(route.request().postData() ?? '').includes('"bureau.reviews.list"')) {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const body = (await response.json()) as { result: Record<string, unknown> };
    body.result = { ...body.result, reviews: [], nextPageToken: null };
    await route.fulfill({ response, json: body });
  });
}

/** One record of the audit trail, as `bureau.audit.query` answers it. */
interface AuditAnswerRecord {
  type: string;
  resource: string;
  timestamp: string;
  detail: Record<string, unknown> | null;
}

/**
 * Answers the trail as the all-clear frame's world holds it: the server's start, and the one
 * refund that was approved and done (order 4472), with the 1,240 events its link names (rows 76l
 * and 76v). The sample world's other runs are the sample world's, not this frame's.
 */
async function answerAllClearActivity(page: Page): Promise<void> {
  await page.route('**/bureau/jsonrpc', async (route) => {
    if (!(route.request().postData() ?? '').includes('"bureau.audit.query"')) {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const body = (await response.json()) as {
      result: { records: AuditAnswerRecord[]; total?: number };
    };
    const { records } = body.result;
    // The refund chat's first run is order 4472 (10:30 AM); its second is order 4471.
    const starts = records
      .filter(
        (record) =>
          record.type === 'run.started' &&
          record.detail?.['sessionId'] === SAMPLE_WORLD_THREADS.refund,
      )
      .toSorted((left, right) => left.timestamp.localeCompare(right.timestamp));
    const refund = starts[0]?.resource;
    const started = records.find((record) => record.type === 'host.started');
    body.result.records = records.filter(
      (record) => record === started || (refund !== undefined && record.resource === refund),
    );
    if (body.result.total !== undefined) body.result.total = 1240;
    await route.fulfill({ response, json: body });
  });
  // With 4471 left out the refund chat holds one message, which is order 4472's, so the chat is
  // titled by it and the line names the run the way the board does.
  await page.route('**/bureau/jsonrpc', async (route) => {
    if (!(route.request().postData() ?? '').includes('"bureau.contexts.get"')) {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const body = (await response.json()) as { result?: { title?: string | null } };
    if ((route.request().postData() ?? '').includes(SAMPLE_WORLD_THREADS.refund)) {
      if (body.result !== undefined) body.result.title = 'Refund order 4472';
    }
    await route.fulfill({ response, json: body });
  });
}

/**
 * Feeds the page's fleet event stream `reports` of the storage's size, `hoursAgo` each, as the
 * engine's own size reports would arrive, and keeps the stream open as the host's does. The sample
 * world's storage holds 1.6 GB (its seed's one reading), so the all-clear frame's 0.4 GB and its
 * flat line over the last day are this stream's, read by the page's own card (row 76v).
 */
async function answerStorageSizes(
  page: Page,
  reports: { bytes: number; hoursAgo: number }[],
): Promise<void> {
  await page.addInitScript((sent) => {
    const { preconnect } = window.fetch;
    const original = window.fetch.bind(window);
    window.fetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const address =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!new URL(address, location.href).pathname.endsWith('/v1/events/sse')) {
          return original(input, init);
        }
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            sent.forEach((report, index) => {
              const emittedAtMs = Date.now() - report.hoursAgo * 3_600_000;
              const envelope = {
                kind: 'storage:size-reported',
                sequence: index + 1,
                cursor: String(index + 1),
                emittedAtMs,
                payload: { sizeBytes: report.bytes },
              };
              controller.enqueue(
                encoder.encode(
                  `id: ${String(index + 1)}\nevent: storage:size-reported\ndata: ${JSON.stringify(envelope)}\n\n`,
                ),
              );
            });
            controller.enqueue(encoder.encode('event: ping\ndata: {"replayComplete":true}\n\n'));
            // The stream stays open, as the host's does, until the page closes it.
            init?.signal?.addEventListener('abort', () => {
              try {
                controller.close();
              } catch {
                // Already closed.
              }
            });
          },
        });
        return Promise.resolve(
          new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }),
        );
      },
      { preconnect },
    );
  }, reports);
}

/** The runs the engine lists for Health's cards: `count` done runs that each took `seconds`. */
async function answerRunsStarted(
  page: Page,
  runs: { started: number; before: number; seconds: number },
) {
  await page.route('**/jsonrpc', async (route) => {
    const text = route.request().postData() ?? '';
    if (!text.includes('"weft.workflows.list"') || !text.includes('createdAt')) {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const body = (await response.json()) as {
      result?: { items: unknown[]; total?: number };
      items?: unknown[];
      total?: number;
    };
    const request = JSON.parse(text) as { params?: { limit?: number; offset?: number } };
    // The window before this one has an upper bound; the window itself has only a lower one.
    const before = /"lt"/.test(text);
    const count = before ? runs.before : runs.started;
    const all = Array.from({ length: count }, (_, index) => ({
      id: `all-clear-run-${before ? 'before' : 'now'}-${String(index)}`,
      status: 'completed',
      createdAt: Date.UTC(2026, 10, 2, 6, 0) + index * 60_000,
      updatedAt: Date.UTC(2026, 10, 2, 6, 0) + index * 60_000 + runs.seconds * 1000,
    }));
    // A page of the window, and how many runs it holds in all: the card for the day before reads
    // only that total, from a page of one, as the engine answers it.
    const offset = request.params?.offset ?? 0;
    const items = all.slice(offset, offset + (request.params?.limit ?? count));
    if (body.result === undefined) {
      body.items = items;
      body.total = count;
    } else {
      body.result.items = items;
      body.result.total = count;
    }
    await route.fulfill({ response, json: body });
  });
}

/** The Needs attention card's rows. */
const attentionRows = (page: Page) =>
  page.locator('main').getByTestId('needs-attention').locator('li');

/** The count chip beside the Needs attention heading. */
const attentionCount = (page: Page) =>
  page.locator('main').getByTestId('needs-attention').locator('.cinder-badge');

/** The sidebar's row for a destination. */
const sidebarRow = (page: Page, name: RegExp | string) =>
  page.getByRole('navigation').getByRole('link', { name });

for (const width of WIDTHS) {
  test(`all clear: Needs attention is one green row, the sidebar has no count and a green dot, at ${width} pixels`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await answerAttention(page, () => listed([]));
    await answerNoReviews(page);
    await answerAllClearActivity(page);
    // The storage holds 0.4 GB, as it has all day (row 76v).
    const gigabyte = 1024 ** 3;
    await answerStorageSizes(page, [
      { bytes: Math.round(0.4 * gigabyte), hoursAgo: 23.5 },
      { bytes: Math.round(0.4 * gigabyte), hoursAgo: 12 },
      { bytes: Math.round(0.4 * gigabyte), hoursAgo: 0.1 },
    ]);
    // 14 runs started and 11 the day before, each done in 1m 12s (row 76v).
    await answerRunsStarted(page, { started: 14, before: 11, seconds: 72 });
    await page.goto('/health');
    const main = page.locator('main');
    const card = main.getByTestId('needs-attention');

    // 76u: one row, a green check tile, the two lines, no count chip and no action.
    await expect(attentionRows(page)).toHaveCount(1);
    await expect(attentionRows(page).first()).toContainText('Nothing needs attention');
    await expect(attentionRows(page).first()).toContainText(
      'Storage, schedules, providers and hooks are fine.',
    );
    await expect(card.locator('h2')).toHaveText('Needs attention');
    await expect(attentionCount(page)).toHaveCount(0);
    await expect(card.locator('a, button')).toHaveCount(0);
    await expect(card.locator('.cinder-stacked-list-item__leading-tile')).toHaveAttribute(
      'data-cinder-tone',
      'success',
    );

    // 76t: the sidebar has no Reviews count, and the Health dot says nothing needs attention.
    // The sidebar is a drawer on a phone, so it is read where it is on the page.
    if (width >= 1024) {
      await expect(sidebarRow(page, 'Reviews')).toBeVisible();
      await expect(sidebarRow(page, /^Health, nothing needs attention$/)).toBeVisible();
    }
    // The Live indicator reads Live, and no amber count or dot sits on the page.
    await expect(main.getByRole('status', { name: /Connection/ })).toContainText('Live');
    await expect(page.locator('.cinder-statistic__attention')).toHaveCount(0);

    // 76v: Recent activity with its audit link, three cards, and Advanced collapsed at the foot.
    await expect(main.getByRole('heading', { level: 2, name: /^Recent activity/ })).toBeVisible();
    await expect(
      main.getByRole('link', { name: /^Open audit log \(1,240 events\)/ }),
    ).toBeVisible();
    // Only what this world did: the refund that was done, and the server's start.
    const lines = main.locator('[data-activity]');
    await expect(lines).toHaveCount(2);
    await expect(lines.nth(0)).toContainText('Run finished, Refund order 4472');
    await expect(lines.nth(1)).toContainText('Server started');
    const cards = main.getByTestId('metric-cards');
    // Storage use: 0.4 GB, a flat line, and the axis from "0.4 GB, 24 hours ago" to "Now".
    const storage = cards.locator('[data-metric="storage"]');
    await expect(storage).toContainText('0.4 GB');
    await expect(storage.locator('.cinder-sparkbar')).toBeVisible();
    await expect(storage).toContainText('0.4 GB, 24 hours ago');
    await expect(storage).toContainText('Now');
    await expect(storage).not.toContainText('Charts fill in');
    await expect(cards.locator('[data-metric="runs-started"]')).toContainText('14');
    await expect(cards.locator('[data-metric="runs-started"]')).toContainText(
      '3 more than the day before',
    );
    await expect(cards.locator('[data-metric="time-to-finish"]')).toContainText('1m 12s');
    await expect(cards.locator('[data-metric="time-to-finish"]')).toContainText(
      // Every run that started finished, so the caption counts runs; the sample world's Overview,
      // where two still wait on you, says "3 finished runs".
      'Median across 14 runs',
    );
    await expect(main.getByTestId('metric-cards').locator('h2')).toHaveText([
      'Storage use',
      'Runs started',
      'Time to finish',
    ]);
    await expect(
      main.getByTestId('advanced-diagnostics').locator('button[aria-expanded]'),
    ).toHaveAttribute('aria-expanded', 'false');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );

    await captureForDesignReview(page, { route: '/health', state: 'all-clear', source: SOURCE });
    await checkA11y(`health all clear at ${width}px`);
  });

  test(`loading: the frame is real, then a skeleton keeps the layout, with no Live indicator and no zero, at ${width} pixels`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    // Never answered: the page stays on its first read for as long as it is open.
    await page.route('**/bureau/jsonrpc', async (route) => {
      if ((route.request().postData() ?? '').includes('"bureau.health.attention"')) return;
      await route.fallback();
    });
    await page.goto('/health');
    const main = page.locator('main');

    // 76w: the heading, the storage line and the tabs are real from the start.
    await expect(main.getByRole('heading', { level: 1, name: 'Health' })).toBeVisible();
    await expect(main.getByTestId('storage-backend')).toContainText('Running on SQLite in');
    await expect(main.getByRole('button', { name: 'Storage details' })).toBeVisible();

    // The skeleton shows once the 300 ms have gone; the counts' labels and the card headings are text.
    const card = main.getByTestId('needs-attention');
    await expect(card.locator('.cinder-skeleton-row')).toHaveCount(3);
    // Each row's dot sits beside its title bar, at a phone's width too, not stacked under it (76x).
    const dot = await card.locator('.cinder-skeleton-status-bar').first().boundingBox();
    const bar = await card.locator('.cinder-skeleton-title-bar').first().boundingBox();
    expect(Math.abs((dot?.y ?? 0) - (bar?.y ?? 100))).toBeLessThan(8);
    expect(dot?.x ?? 0).toBeLessThan(bar?.x ?? 0);
    const counts = main.getByRole('group', { name: 'Health counts' });
    await expect(counts.locator('.cinder-statistic__label')).toHaveText([
      'Running now',
      'Needs you',
      'Failed in 24 hours',
      'Missed schedule runs (7 days)',
    ]);
    // 76x: a placeholder block stands where each count will be, never a zero.
    await expect(counts.locator('.cinder-skeleton')).toHaveCount(4);
    await expect(counts.locator('.cinder-statistic__value')).toHaveText(['', '', '', '']);
    await expect(card.locator('h2')).toHaveText('Needs attention');
    await expect(attentionCount(page)).toHaveCount(0);
    await expect(main.getByTestId('metric-cards').locator('h2')).toHaveText([
      'Storage use',
      'Runs started',
      'Time to finish',
    ]);
    await expect(main.getByTestId('metric-cards').locator('.cinder-skeleton')).toHaveCount(6);
    // The Live indicator is not drawn while the page loads, and nothing below the cards is.
    await expect(main.getByRole('status', { name: /Connection/ })).toHaveCount(0);
    await expect(main.getByRole('heading', { level: 2, name: /^Recent activity/ })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );

    await captureForDesignReview(page, { route: '/health', state: 'loading', source: SOURCE });
    await checkA11y(`health loading at ${width}px`);
  });
}

/** What a button on a row is called, and where it goes. */
const action = (page: Page, row: number, name: string) =>
  attentionRows(page).nth(row).getByRole('link', { name });

test('a deployment with a remote worker that stopped answering lists it second, between the provider and the storage rows', async ({
  page,
  checkA11y,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await answerAttention(page, (answer) =>
    listed([
      ...answer.items,
      {
        kind: 'worker-disconnected',
        area: 'workers',
        at: today(9, 41),
        workerId: 'reports-worker',
        workerName: 'Reports worker',
        queue: 'reports',
        waiting: 12,
        failedForGood: 2,
      } as AttentionAnswer['items'][number],
    ]),
  );
  await page.goto('/health');

  // 76y: the count is 4, the new row sits second, and the other three are unchanged.
  await expect(attentionRows(page)).toHaveCount(4);
  await expect(attentionCount(page)).toHaveText('4');
  await expect(attentionRows(page).nth(0)).toContainText('No model provider connected');
  const worker = attentionRows(page).nth(1);
  await expect(worker).toContainText('Reports worker is disconnected');
  await expect(worker).toContainText(
    /12 tasks are waiting for the reports queue and 2 failed for good\. It was last heard from at 9:41 AM and reconnects by itself when its process starts again\./,
  );
  await expect(action(page, 1, 'View worker')).toHaveAttribute(
    'href',
    '/health/workers?worker=reports-worker',
  );
  await expect(action(page, 1, 'View worker')).toHaveAttribute('data-cinder-variant', 'secondary');
  await expect(attentionRows(page).nth(2)).toContainText('Storage is over its warning level');
  await expect(attentionRows(page).nth(3)).toContainText('Daily summary missed 4 runs');
  // The checks say the same four problems.
  await page.goto('/health?advanced=open');
  await expect(page.getByTestId('advanced-diagnostics')).toContainText(
    '4 need attention, Storage, Schedules, Providers, Workers',
  );
  await page.goto('/health');
  await expect(attentionRows(page)).toHaveCount(4);
  await captureForDesignReview(page, {
    route: '/health',
    state: 'worker-disconnected',
    source: SOURCE,
  });
  await checkA11y('health with a disconnected worker');
});

test('a hook whose last delivery failed adds a row second, after the provider', async ({
  page,
  checkA11y,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await answerAttention(page, (answer) =>
    listed([
      ...answer.items,
      {
        kind: 'hook-failed',
        area: 'hooks',
        at: today(10, 42),
        hookId: 'notify-slack',
        hookName: 'Notify Slack when a review is waiting',
        gaveUp: false,
        status: 410,
        host: 'hooks.slack.com',
        attempts: 3,
        error: null,
      } as AttentionAnswer['items'][number],
    ]),
  );
  await page.goto('/health');

  // 77a, 77b: a count of 4 in neutral, the hook second (most recent first), its own button.
  await expect(attentionCount(page)).toHaveText('4');
  await expect(attentionRows(page)).toHaveCount(4);
  // The list is ordered once, most recent first: provider 10:45 AM, the hook 10:42 AM, storage
  // 9:05 AM, then Daily summary; the sidebar's Health dot stays amber.
  await expect(attentionRows(page).nth(0)).toContainText('No model provider connected');
  await expect(attentionRows(page).nth(2)).toContainText('Storage is over its warning level');
  await expect(attentionRows(page).nth(3)).toContainText('Daily summary missed 4 runs');
  await expect(
    sidebarRow(page, 'Health, 4 need attention').locator('.cinder-status-dot'),
  ).toHaveAttribute('data-cinder-status', 'warning');
  const hook = attentionRows(page).nth(1);
  await expect(hook).toContainText(
    'Notify Slack when a review is waiting’s last delivery failed, 410 Gone',
  );
  await expect(hook).toContainText(
    'hooks.slack.com answered 410 Gone on its last try at 10:42 AM.',
  );
  await expect(action(page, 1, 'View hook')).toHaveAttribute('data-cinder-variant', 'secondary');
  await expect(action(page, 1, 'View hook')).toHaveAttribute('href', '/hooks/notify-slack');
  await captureForDesignReview(page, {
    route: '/health',
    state: 'hook-failed',
    source: SOURCE,
  });
  await checkA11y('health with a hook whose last delivery failed');
});

test('a hook that gave up counts like one whose last delivery failed, and sits last because it is the oldest', async ({
  page,
  checkA11y,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await answerAttention(page, (answer) =>
    listed([
      ...answer.items,
      {
        kind: 'hook-failed',
        area: 'hooks',
        at: Date.UTC(2026, 9, 30, 15, 3),
        hookId: 'page-on-call',
        hookName: 'Page on-call when a run fails',
        gaveUp: true,
        status: 410,
        host: 'hooks.example.test',
        attempts: 8,
        error: null,
      } as AttentionAnswer['items'][number],
    ]),
  );
  await page.goto('/health');

  // 77c, 77d: the provider, storage, Daily summary, then the hook, with the same button, and the
  // sidebar's Health dot amber.
  await expect(
    sidebarRow(page, 'Health, 4 need attention').locator('.cinder-status-dot'),
  ).toHaveAttribute('data-cinder-status', 'warning');
  await expect(attentionCount(page)).toHaveText('4');
  await expect(attentionRows(page)).toHaveCount(4);
  await expect(attentionRows(page).nth(0)).toContainText('No model provider connected');
  await expect(attentionRows(page).nth(1)).toContainText('Storage is over its warning level');
  await expect(attentionRows(page).nth(2)).toContainText('Daily summary missed 4 runs');
  const hook = attentionRows(page).nth(3);
  await expect(hook).toContainText('Page on-call when a run fails gave up, 410 Gone');
  await expect(hook).toContainText(
    'Stopped after 8 tries on Oct 30. The URL may have been removed.',
  );
  await expect(action(page, 3, 'View hook')).toHaveAttribute('data-cinder-variant', 'secondary');
  await captureForDesignReview(page, { route: '/health', state: 'hook-gave-up', source: SOURCE });
  await checkA11y('health with a hook that gave up');
});

test('a plugin that did not load adds a row with Open Plugins, and the count is 3', async ({
  page,
  checkA11y,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await answerAttention(page, (answer) => {
    const plugin = {
      kind: 'plugin-not-loaded',
      area: 'plugins',
      at: today(9, 0),
      plugin: 'web-search',
      problems: ['load-failed'],
    } as AttentionAnswer['items'][number];
    // The frame lists the provider row, then the plugin's, then the storage row; Daily summary is
    // not in it. The plugin is second whatever the times say, as the design draws it (row 77l).
    const rest = answer.items.filter((item) => item.kind !== 'missed-runs');
    const everything = listed([...rest, plugin]);
    const [provider, ...others] = listed(rest).items;
    if (provider === undefined) throw new Error('the sample world lists the missing provider');
    return { ...everything, items: [provider, plugin, ...others] };
  });
  await page.goto('/health');

  // 77l: the count chip reads 3, and the row names the plugin, says when it failed to start, and opens Plugins.
  await expect(attentionCount(page)).toHaveText('3');
  await expect(attentionRows(page)).toHaveCount(3);
  // The order the design draws: the provider row, this row, then the storage row.
  await expect(attentionRows(page).nth(0)).toContainText('No model provider connected');
  await expect(attentionRows(page).nth(1)).toContainText('Web search didn’t load');
  await expect(attentionRows(page).nth(2)).toContainText('Storage is over its warning level');
  const plugin = attentionRows(page).filter({ hasText: 'Web search didn’t load' });
  await expect(plugin).toHaveCount(1);
  await expect(plugin).toContainText(
    'Its tools aren’t available to agents until it loads. Interborough couldn’t start it at 9:00 AM.',
  );
  await expect(plugin.getByRole('link', { name: 'Open Plugins' })).toHaveAttribute(
    'href',
    '/settings/plugins',
  );
  await expect(plugin.getByRole('link', { name: 'Open Plugins' })).toHaveAttribute(
    'data-cinder-variant',
    'secondary',
  );
  await expect(
    attentionRows(page).filter({ hasText: 'Storage is over its warning level' }),
  ).toHaveCount(1);
  await captureForDesignReview(page, {
    route: '/health',
    state: 'plugin-not-loaded',
    source: SOURCE,
  });
  await checkA11y('health with a plugin that did not load');
});
