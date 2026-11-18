/**
 * Home's two activity bands (COR-2227, design rows F7-01 to F7-50, board `home-activity`):
 * Workflow activity from the engine's fleet feed and Agent activity from the Bureau's own feed, the
 * page's last region, after Recent chats, side by side when the region is at least 54rem wide and
 * stacked under that.
 *
 * Each state is made the way the application would meet it: the two feeds are answered in the
 * page (`scriptFeeds`, as `health-states.spec.ts` answers the fleet feed), with a replay that ends
 * and a stream that stays open, and `bureau.events.format` is answered with the words a plugin's
 * formatter would write (`wordEvents`). Everything else is the sample world's own host. Each state
 * is captured for the design review at 1280, 768 and 375 pixels (and 320 with it).
 */
import type { Page } from '@playwright/test';

import {
  SAMPLE_NOW,
  SAMPLE_NOW_MILLISECONDS,
  SAMPLE_TIME_ZONE,
} from '../../fixtures/sample-now.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';
import { readBoxes } from './read-boxes.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'home-activity.spec.ts';

type Feed = 'fleet' | 'bureau';

/** How the page answers one feed: the chunks of each connection in turn, or a refusal, or never. */
interface FeedPlan {
  readonly connections?: readonly (readonly string[])[];
  readonly refuse?: number;
  readonly hold?: boolean;
}

interface FeedControl {
  push(feed: Feed, chunk: string): void;
  drop(feed: Feed): void;
  opened(feed: Feed): number;
}

declare global {
  interface Window {
    /** The scripted feeds' controls, installed by `scriptFeeds`. */
    __activityFeeds?: FeedControl;
  }
}

const REPLAY_COMPLETE = 'event: ping\ndata: {"replayComplete":true}\n\n';

/** One envelope as either feed writes it. */
function envelope(
  cursor: string,
  kind: string,
  emittedAtMs: number,
  payload: Record<string, unknown> = {},
): string {
  const workflowId = payload['workflowId'];
  const data = {
    kind,
    cursor,
    sequence: Number(cursor.split(':')[1] ?? 1),
    emittedAtMs,
    payload,
    ...(typeof workflowId === 'string' ? { workflowId } : {}),
  };
  return `id: ${cursor}\nevent: ${kind}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Answers the two feeds in the page as `plans` say, and keeps each stream open until it is closed. */
async function scriptFeeds(page: Page, plans: Readonly<Record<Feed, FeedPlan>>): Promise<void> {
  await page.addInitScript((sent) => {
    const encoder = new TextEncoder();
    const opened: Record<Feed, number> = { fleet: 0, bureau: 0 };
    const streams: Record<Feed, ReadableStreamDefaultController<Uint8Array>[]> = {
      fleet: [],
      bureau: [],
    };
    const feedOf = (address: string): Feed | undefined => {
      const path = new URL(address, location.href).pathname;
      if (path.endsWith('/bureau/v1/subscriptions/bureau.events')) return 'bureau';
      if (path.endsWith('/v1/events/sse')) return 'fleet';
      return undefined;
    };
    const { preconnect } = window.fetch;
    const original = window.fetch.bind(window);
    window.fetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const address =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const feed = feedOf(address);
        if (feed === undefined) return original(input, init);
        const plan = sent[feed];
        if (plan.refuse !== undefined) {
          return Promise.resolve(new Response('refused', { status: plan.refuse }));
        }
        // A feed that never answers: the band waits on its first window.
        if (plan.hold === true) return new Promise<Response>(() => undefined);
        const connections = plan.connections ?? [[]];
        const chunks = connections[Math.min(opened[feed], connections.length - 1)] ?? [];
        opened[feed] += 1;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            streams[feed].push(controller);
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
    window.__activityFeeds = {
      push(feed, chunk) {
        streams[feed].at(-1)?.enqueue(encoder.encode(chunk));
      },
      drop(feed) {
        try {
          streams[feed].at(-1)?.close();
        } catch {
          // Already closed.
        }
      },
      opened(feed) {
        return opened[feed];
      },
    };
  }, plans);
}

/** What a plugin's formatter writes for an event, looked up by the `label` of its payload. */
type Wording = Readonly<{
  title: string;
  body?: string;
  tier?: 'info' | 'warning' | 'critical';
  icon?: string;
  link?: string;
  runId?: string;
}>;

/**
 * Answers `bureau.events.format` with `wordings` (an event whose payload's `label` has none is
 * unclaimed, as the Bureau answers a kind no formatter claims), or fails every call.
 */
async function wordEvents(
  page: Page,
  wordings: ReadonlyMap<string, Wording> | 'fail',
): Promise<void> {
  await page.route('**/bureau/jsonrpc', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as {
      id?: unknown;
      method?: string;
      params?: { events?: { kind: string; payload?: { label?: string } }[] };
    };
    if (body.method !== 'bureau.events.format') {
      await route.fallback();
      return;
    }
    if (wordings === 'fail') {
      await route.fulfill({
        json: {
          jsonrpc: '2.0',
          id: body.id,
          error: { code: -32603, message: 'The formatter host stopped.' },
        },
      });
      return;
    }
    const events = (body.params?.events ?? []).map((event) => {
      const wording = wordings.get(event.payload?.label ?? '');
      return wording === undefined
        ? { kind: event.kind, title: event.kind, tier: 'info' }
        : { kind: event.kind, formattedBy: 'showcase/words', tier: 'info', ...wording };
    });
    await route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result: { events } } });
  });
}

/** 10:42 AM today, and so on, in Central time. */
const minutesAgo = (minutes: number) => SAMPLE_NOW_MILLISECONDS - minutes * 60_000;
const TODAY = minutesAgo(4);
const YESTERDAY = Date.parse('2026-11-01T16:12:00-06:00');
const OLDER = Date.parse('2026-10-29T16:12:00-05:00');

const workflow = (page: Page) => page.locator('[data-home-card="Workflow activity"]');
const agents = (page: Page) => page.locator('[data-home-card="Agent activity"]');
const rowsOf = (band: ReturnType<typeof workflow>) => band.locator('.cinder-grouped-list-item');

/** Opens Home at `width` and waits until it has loaded. */
async function openHome(page: Page, width: number): Promise<void> {
  await page.clock.setFixedTime(SAMPLE_NOW);
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('home-counts')).toBeVisible();
}

/** Captures the page at each width the design review reads (375 brings 320 with it). */
async function captureEachWidth(
  page: Page,
  state: string,
  ready: (page: Page) => Promise<void>,
): Promise<void> {
  for (const width of [1280, 768, 375]) {
    await page.setViewportSize({ width, height: 900 });
    await ready(page);
    await page.getByTestId('home-activity').scrollIntoViewIfNeeded();
    await captureForDesignReview(page, { route: '/', state, source: SOURCE, ready });
  }
}

const READY_FLEET = [
  envelope('f:1', 'worker:connected', OLDER, { workerId: 'worker-7', queue: 'default' }),
  envelope('f:2', 'workflow:started', YESTERDAY, {
    workflowId: 'release-notes-digest-1104',
    workflowType: 'Release notes digest',
  }),
  envelope('f:3', 'workflow:failed', TODAY, {
    workflowId: 'release-notes-digest-1104',
    error:
      'The model provider refused the request because the monthly token budget for this key is spent, and the step gave up after three tries',
  }),
  // Telemetry the band leaves out.
  envelope('f:4', 'storage:size-reported', minutesAgo(1), { sizeBytes: 1_600_000_000 }),
];

const READY_AGENTS = [
  envelope('b:1', 'hook.delivery.retried', minutesAgo(34), { label: 'hook' }),
  envelope('b:2', 'chat.started', minutesAgo(16), { label: 'chat' }),
  envelope('b:3', 'review.requested', minutesAgo(6), { label: 'review', runId: 'run-refund' }),
];

const READY_WORDS = new Map<string, Wording>([
  [
    'review',
    {
      title:
        'Tool runner asks to refund order 4471 for $42.00 to the original card, plus the $6.00 return shipping the customer paid last week',
      body: 'The parcel arrived damaged and the carrier accepted the claim; the refund is over the $25.00 limit that runs without a review, so it waits on you',
      tier: 'warning',
      icon: 'user-check',
      link: '/reviews',
    },
  ],
  ['chat', { title: 'Chat started with Assistant', tier: 'info', icon: 'message-square' }],
  [
    'hook',
    {
      title: 'Slack notify delivery failed',
      body: 'Attempt 2 of 5, next try at 10:20 AM',
      tier: 'critical',
      icon: 'webhook',
    },
  ],
]);

const bandsReady = async (page: Page) => {
  await expect(rowsOf(workflow(page))).toHaveCount(3);
  await expect(rowsOf(agents(page))).toHaveCount(3);
};

test.describe('Home activity bands (COR-2227)', () => {
  test('activity ready: two bands after Recent chats, three rows each, newest first', async ({
    page,
    checkA11y,
  }) => {
    await scriptFeeds(page, {
      fleet: { connections: [[...READY_FLEET, REPLAY_COMPLETE]] },
      bureau: { connections: [[...READY_AGENTS, REPLAY_COMPLETE]] },
    });
    await wordEvents(page, READY_WORDS);
    await openHome(page, 1280);
    await bandsReady(page);

    // F7-10, F7-12: the headings and the lists' names.
    await expect(workflow(page).getByRole('heading', { level: 2 })).toHaveText('Workflow activity');
    await expect(agents(page).getByRole('heading', { level: 2 })).toHaveText('Agent activity');
    await expect(page.getByRole('list', { name: 'Recent workflow activity' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Recent agent activity' })).toBeVisible();
    // F7-11: nothing at the end of a heading.
    await expect(workflow(page).locator('.cinder-section__actions')).toHaveCount(0);

    // F7-17, F7-20, F7-24, F7-26: newest first, the tier word leading line two, the time, the link.
    await expect(rowsOf(workflow(page)).locator('.cinder-grouped-list-item__title')).toHaveText([
      'Run failed',
      'Run started',
      'Worker connected',
    ]);
    const failed = rowsOf(workflow(page)).first();
    await expect(failed.locator('.cinder-status-dot')).toHaveAttribute(
      'data-cinder-status',
      'danger',
    );
    await expect(failed.locator('.cinder-status-dot')).toHaveText('Critical');
    await expect(failed.locator('time')).toHaveText('10:42 AM');
    await expect(failed.getByRole('link')).toHaveAttribute(
      'href',
      '/runs/release-notes-digest-1104',
    );
    await expect(rowsOf(workflow(page)).nth(1).locator('time')).toHaveText('Yesterday, 4:12 PM');
    await expect(rowsOf(workflow(page)).nth(2).locator('time')).toHaveText('Thu, Oct 29, 4:12 PM');
    // F7-27: a row with no link is not a link and has no chevron.
    await expect(rowsOf(workflow(page)).nth(2).getByRole('link')).toHaveCount(0);
    await expect(
      rowsOf(workflow(page)).nth(2).locator('.cinder-grouped-list-item__chevron'),
    ).toHaveCount(0);
    const review = rowsOf(agents(page)).first();
    await expect(review.locator('.cinder-status-dot')).toHaveText('Warning');
    await expect(rowsOf(agents(page)).nth(1).locator('.cinder-status-dot')).toHaveCount(0);
    // F7-49: the clamped text reads in one tooltip on the row.
    await expect(review).toHaveAttribute('title', /^Tool runner asks to refund order 4471/);

    // F7-01, F7-02, F7-03: after Recent chats, side by side in two equal columns, 32 pixels apart.
    const side = await readBoxes(page, {
      recent: page.locator('[data-home-card="Recent chats"]'),
      left: workflow(page),
      right: agents(page),
      leftHeading: workflow(page).getByRole('heading', { level: 2 }),
      rightHeading: agents(page).getByRole('heading', { level: 2 }),
      leftFirstRow: rowsOf(workflow(page)).first(),
      rightFirstRow: rowsOf(agents(page)).first(),
    });
    expect(side.left.y).toBeGreaterThan(side.recent.y + side.recent.height);
    expect(Math.abs(side.left.y - side.right.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(side.leftHeading.y - side.rightHeading.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(side.leftFirstRow.y - side.rightFirstRow.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(side.left.width - side.right.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(side.right.x - (side.left.x + side.left.width) - 32)).toBeLessThanOrEqual(1);

    // F7-26: a row opens its link inside the application (the run above is the script's own, so
    // the review row, whose page the sample world has, is the one followed).
    await review.getByRole('link').click();
    await expect(page).toHaveURL(/\/reviews$/);
    await page.goBack();
    await bandsReady(page);
    await checkA11y('Home with both activity bands');
    await captureEachWidth(page, 'activity ready', bandsReady);
  });

  test('activity stacked: under 54rem of region the bands stack, Workflow activity first', async ({
    page,
  }) => {
    await scriptFeeds(page, {
      fleet: { connections: [[...READY_FLEET, REPLAY_COMPLETE]] },
      bureau: { connections: [[...READY_AGENTS, REPLAY_COMPLETE]] },
    });
    await wordEvents(page, READY_WORDS);
    for (const width of [768, 375]) {
      await openHome(page, width);
      await bandsReady(page);
      const stacked = await readBoxes(page, { top: workflow(page), bottom: agents(page) });
      // F7-04: 32 pixels between the stacked bands, not the region's gap plus Cinder's margin
      // between adjacent Sections (64 before each band had its own wrapper).
      expect(
        Math.abs(stacked.bottom.y - (stacked.top.y + stacked.top.height) - 32),
      ).toBeLessThanOrEqual(1);
      expect(Math.abs(stacked.top.width - stacked.bottom.width)).toBeLessThanOrEqual(1);
    }

    // F7-39: stacked, a mouse resting on Agent activity holds Workflow activity too, so a workflow
    // arrival cannot change the height above the row it rests on. Any change to Workflow activity's
    // list while the mouse rests is recorded, and the Agent arrival pushed after the workflow one,
    // whose format call is awaited, marks that both have reached the page.
    const workflowTitles = rowsOf(workflow(page)).locator('.cinder-grouped-list-item__title');
    await expect(workflowTitles.first()).toHaveText('Run failed');
    await rowsOf(agents(page)).nth(1).hover();
    await workflow(page).evaluate((band) => {
      const record = window as Window & { __workflowMoved?: boolean };
      record.__workflowMoved = false;
      new MutationObserver(() => {
        record.__workflowMoved = true;
      }).observe(band, { childList: true, subtree: true, characterData: true });
    });
    const worded = page.waitForResponse(
      (response) =>
        response.url().endsWith('/bureau/jsonrpc') &&
        (response.request().postData() ?? '').includes('"stacked-arrival"'),
    );
    await page.evaluate(
      ([fleetChunk, bureauChunk]) => {
        window.__activityFeeds?.push('fleet', fleetChunk);
        window.__activityFeeds?.push('bureau', bureauChunk);
      },
      [
        envelope('f:5', 'workflow:completed', minutesAgo(0), { workflowId: 'digest-1103' }),
        envelope('b:4', 'chat.started', minutesAgo(0), { label: 'stacked-arrival' }),
      ] as const,
    );
    await worded;
    await expect(workflowTitles.first()).toHaveText('Run failed');
    expect(
      await page.evaluate(() => (window as Window & { __workflowMoved?: boolean }).__workflowMoved),
    ).toBe(false);
    await page.mouse.move(0, 0);
    await expect(workflowTitles.first()).toHaveText('Run finished');
  });

  test('activity without a run: the bands keep their place under Recent chats (F7-06)', async ({
    page,
  }) => {
    await scriptFeeds(page, {
      fleet: { connections: [[...READY_FLEET, REPLAY_COMPLETE]] },
      bureau: { connections: [[...READY_AGENTS, REPLAY_COMPLETE]] },
    });
    await wordEvents(page, READY_WORDS);
    // No run is going: the Bureau lists no working or submitted task.
    await page.route('**/bureau/jsonrpc', async (route) => {
      const body = JSON.parse(route.request().postData() ?? '{}') as {
        id?: unknown;
        method?: string;
      };
      if (body.method !== 'bureau.tasks.list') {
        await route.fallback();
        return;
      }
      await route.fulfill({
        json: { jsonrpc: '2.0', id: body.id, result: { tasks: [], nextPageToken: null } },
      });
    });
    for (const width of [1280, 375]) {
      await openHome(page, width);
      await bandsReady(page);
      await expect(page.locator('[data-home-card="Running now"]')).toHaveCount(0);
      // The activity region is the page's last region, right under Recent chats, from its leading
      // edge, with the region's 24px gap between them.
      await expect(
        page.locator('[data-page="home"] > :last-child[data-testid="home-activity"]'),
      ).toHaveCount(1);
      const placed = await readBoxes(page, {
        recent: page.locator('[data-home-card="Recent chats"]'),
        region: page.getByTestId('home-activity'),
        first: workflow(page),
      });
      expect(
        Math.abs(placed.region.y - (placed.recent.y + placed.recent.height) - 24),
      ).toBeLessThanOrEqual(1);
      expect(Math.abs(placed.first.y - placed.region.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(placed.region.x - placed.recent.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(placed.region.width - placed.recent.width)).toBeLessThanOrEqual(1);
    }
  });

  test('activity flat: each band is a Section over one GroupedList, with no box around or in it (F7-09)', async ({
    page,
  }) => {
    await scriptFeeds(page, {
      fleet: { connections: [[...READY_FLEET, REPLAY_COMPLETE]] },
      bureau: { connections: [[...READY_AGENTS, REPLAY_COMPLETE]] },
    });
    await wordEvents(page, READY_WORDS);
    for (const width of [1280, 375]) {
      await openHome(page, width);
      await bandsReady(page);
      for (const band of [workflow(page), agents(page)]) {
        await expect(band).toHaveClass(/\bcinder-section\b/);
        await expect(band.getByRole('heading', { level: 2 })).toHaveCount(1);
        await expect(band.locator('.cinder-grouped-list')).toHaveCount(1);
        await expect(band.getByRole('list')).toHaveCount(1);
      }
      // Move the pointer off the rows, so no row draws its hover surface.
      await page.mouse.move(0, 0);
      const boxes = await page.getByTestId('home-activity').evaluate((region) => {
        const sides = ['top', 'right', 'bottom', 'left'] as const;
        const transparent = 'rgba(0, 0, 0, 0)';
        /** The sides an element draws a border on, and whether it draws a surface or a shadow. */
        const drawn = (element: Element) => {
          const style = getComputedStyle(element);
          return {
            borders: sides.filter(
              (side) =>
                Number.parseFloat(style.getPropertyValue(`border-${side}-width`)) > 0 &&
                style.getPropertyValue(`border-${side}-style`) !== 'none' &&
                style.getPropertyValue(`border-${side}-color`) !== transparent,
            ),
            tinted:
              style.backgroundColor !== transparent ||
              style.backgroundImage !== 'none' ||
              style.boxShadow !== 'none',
          };
        };
        const nameOf = (element: Element) =>
          `${element.tagName.toLowerCase()}.${[...element.classList].join('.')}`;
        const offenders: string[] = [];
        // Nothing around the pair or around a band.
        const around = [
          region,
          ...region.querySelectorAll('.ib-home__activity-bands, .ib-home__activity-band'),
          ...region.querySelectorAll('[data-home-card]'),
        ];
        for (const element of around) {
          const { borders, tinted } = drawn(element);
          if (borders.length > 0 || tinted) offenders.push(`around: ${nameOf(element)}`);
        }
        // Inside a row, only the separator (the content's bottom edge) and the status dot's own
        // dot are drawn: no bordered or tinted box.
        for (const row of region.querySelectorAll('.cinder-grouped-list-item')) {
          for (const element of [row, ...row.querySelectorAll('*')]) {
            if (element.matches('.cinder-status-dot__indicator')) continue;
            const { borders, tinted } = drawn(element);
            const allowed = element.matches('.cinder-grouped-list-item__content') ? ['bottom'] : [];
            if (tinted || borders.some((side) => !allowed.includes(side))) {
              offenders.push(`in a row: ${nameOf(element)}`);
            }
          }
        }
        return offenders;
      });
      expect(boxes).toEqual([]);
    }
  });

  test('activity times: today, yesterday and older, linked and unlinked', async ({ page }) => {
    await scriptFeeds(page, {
      fleet: {
        connections: [
          [
            envelope('f:1', 'workflow:completed', OLDER, { workflowId: 'digest-1029' }),
            envelope('f:2', 'workflow:completed', YESTERDAY, { workflowId: 'digest-1101' }),
            envelope('f:3', 'workflow:completed', TODAY, { workflowId: 'digest-1102' }),
            REPLAY_COMPLETE,
          ],
        ],
      },
      bureau: {
        connections: [
          [
            envelope('b:1', 'chat.ended', OLDER, { label: 'older' }),
            envelope('b:2', 'chat.ended', YESTERDAY, { label: 'yesterday' }),
            envelope('b:3', 'chat.ended', TODAY, { label: 'today' }),
            REPLAY_COMPLETE,
          ],
        ],
      },
    });
    await wordEvents(
      page,
      new Map<string, Wording>([
        ['older', { title: 'Chat with Researcher ended', icon: 'message-square' }],
        ['yesterday', { title: 'Chat with Tool runner ended', icon: 'message-square' }],
        ['today', { title: 'Chat with Assistant ended', icon: 'message-square' }],
      ]),
    );
    // F7-48: the third chat Home lists was last active on Thursday, Oct 29, so Recent chats shows
    // all three time forms too. Only a list with a third chat is rewritten.
    await page.route('**/bureau/jsonrpc', async (route) => {
      const body = JSON.parse(route.request().postData() ?? '{}') as { method?: string };
      if (body.method !== 'bureau.contexts.list') {
        await route.fallback();
        return;
      }
      const response = await route.fetch();
      const json = (await response.json()) as {
        result?: { contexts?: { updatedAt?: string }[] };
      };
      const third = json.result?.contexts?.[2];
      if (third !== undefined) third.updatedAt = new Date(OLDER).toISOString();
      await route.fulfill({ response, json });
    });
    await openHome(page, 1280);
    await bandsReady(page);
    await expect(rowsOf(agents(page)).locator('time')).toHaveText([
      '10:42 AM',
      'Yesterday, 4:12 PM',
      'Thu, Oct 29, 4:12 PM',
    ]);
    await expect(rowsOf(workflow(page)).getByRole('link')).toHaveCount(3);
    await expect(rowsOf(agents(page)).getByRole('link')).toHaveCount(0);

    // F7-48: at 320 Recent chats keeps the older time beside the title, on the title's first line.
    await page.setViewportSize({ width: 320, height: 900 });
    const olderChat = page
      .locator('[data-home-card="Recent chats"] .cinder-grouped-list-item')
      .nth(2);
    const olderTime = olderChat.locator('.cinder-grouped-list-item__trailing');
    await expect(olderTime).toHaveText('Thu, Oct 29, 4:12 PM');
    const placed = await readBoxes(page, {
      title: olderChat.locator('.cinder-grouped-list-item__title'),
      time: olderTime,
    });
    expect(Math.abs(placed.time.y - placed.title.y)).toBeLessThanOrEqual(1);
    expect(placed.time.x).toBeGreaterThan(placed.title.x);
    await captureEachWidth(page, 'activity times', bandsReady);
  });

  test('activity without glyphs: an absent or unknown icon is the activity glyph at every tier', async ({
    page,
  }) => {
    await scriptFeeds(page, {
      fleet: {
        connections: [
          [
            envelope('f:1', 'lease:health-changed', minutesAgo(40), { state: 'healthy' }),
            envelope('f:2', 'realm:state-changed', minutesAgo(20), { state: 'active' }),
            envelope('f:3', 'workflow:timed-out', minutesAgo(9), { workflowId: 'digest-1102' }),
            REPLAY_COMPLETE,
          ],
        ],
      },
      bureau: {
        connections: [
          [
            envelope('b:1', 'goal.updated', minutesAgo(30), { label: 'info' }),
            envelope('b:2', 'goal.stalled', minutesAgo(20), { label: 'warning' }),
            envelope('b:3', 'goal.failed', minutesAgo(10), { label: 'critical' }),
            REPLAY_COMPLETE,
          ],
        ],
      },
    });
    await wordEvents(
      page,
      new Map<string, Wording>([
        // F7-46: an info row whose title names a failure is still an info row.
        ['info', { title: 'Run failed to start', body: 'Ship the release notes', tier: 'info' }],
        [
          'warning',
          {
            title: 'Goal has not moved in a day',
            body: 'Ship the release notes',
            tier: 'warning',
            icon: 'not-a-lucide-icon',
          },
        ],
        ['critical', { title: 'Goal failed', body: 'Ship the release notes', tier: 'critical' }],
      ]),
    );
    await openHome(page, 1280);
    await bandsReady(page);
    // F7-46: a row's tier comes from the formatter, never its words: the info row titled with a
    // failure draws no status dot, no tier word and no status colour, while the warning and
    // critical rows draw theirs.
    const failureWorded = rowsOf(agents(page)).filter({ hasText: 'Run failed to start' });
    await expect(failureWorded).toHaveCount(1);
    await expect(failureWorded.locator('.cinder-status-dot')).toHaveCount(0);
    await expect(failureWorded).not.toContainText(/Warning|Critical/);
    await expect(
      rowsOf(agents(page)).filter({ hasText: 'Goal failed' }).locator('.cinder-status-dot'),
    ).toHaveText('Critical');
    await expect(
      rowsOf(agents(page))
        .filter({ hasText: 'Goal has not moved in a day' })
        .locator('.cinder-status-dot'),
    ).toHaveText('Warning');
    await captureEachWidth(page, 'activity without glyphs', bandsReady);
  });

  test('activity unclaimed: a kind no formatter claims reads in plain words with its raw kind', async ({
    page,
  }) => {
    await scriptFeeds(page, {
      fleet: {
        connections: [
          [
            envelope('f:1', 'workflow:started', minutesAgo(30), {
              workflowId: 'digest-1102',
              workflowType: 'Release notes digest',
            }),
            envelope('f:2', 'lease:health-changed', minutesAgo(12), { state: 'degraded' }),
            REPLAY_COMPLETE,
          ],
        ],
      },
      bureau: {
        connections: [
          [
            envelope('b:1', 'chat.started', minutesAgo(25), { label: 'chat' }),
            envelope('b:2', 'goal.attempt.started', minutesAgo(15), { goalRunId: 'goal-run-3' }),
            envelope(
              'b:3',
              'plugin.github-sync.repository.webhook-delivery.retried-after-backoff',
              minutesAgo(5),
            ),
            REPLAY_COMPLETE,
          ],
        ],
      },
    });
    await wordEvents(page, READY_WORDS);
    await openHome(page, 1280);
    await expect(rowsOf(agents(page))).toHaveCount(3);
    const unclaimed = rowsOf(agents(page)).first();
    await expect(unclaimed.locator('.cinder-grouped-list-item__title')).toHaveText(
      'Plugin github sync repository webhook delivery retried after backoff',
    );
    await expect(unclaimed.locator('code')).toHaveText(
      'plugin.github-sync.repository.webhook-delivery.retried-after-backoff',
    );
    await expect(rowsOf(agents(page)).nth(1).getByRole('link')).toHaveAttribute(
      'href',
      '/runs/goal-run-3',
    );
    await expect(rowsOf(workflow(page)).first().locator('code')).toHaveText('lease:health-changed');
    const ready = async (current: Page) => {
      await expect(rowsOf(agents(current))).toHaveCount(3);
      await expect(rowsOf(workflow(current))).toHaveCount(2);
    };
    await captureEachWidth(page, 'activity unclaimed', ready);
  });

  test('activity format failed: the events are listed in plain words, with no error anywhere', async ({
    page,
  }) => {
    await scriptFeeds(page, {
      fleet: { connections: [[...READY_FLEET, REPLAY_COMPLETE]] },
      bureau: { connections: [[...READY_AGENTS, REPLAY_COMPLETE]] },
    });
    await wordEvents(page, 'fail');
    await openHome(page, 1280);
    await bandsReady(page);
    await expect(rowsOf(agents(page)).locator('.cinder-grouped-list-item__title')).toHaveText([
      'Review requested',
      'Chat started',
      'Hook delivery retried',
    ]);
    await expect(agents(page).locator('code')).toHaveCount(3);
    await expect(rowsOf(agents(page)).first().getByRole('link')).toHaveAttribute(
      'href',
      '/runs/run-refund',
    );
    await expect(agents(page).getByRole('button')).toHaveCount(0);
    await expect(agents(page).getByRole('alert')).toHaveCount(0);
    await expect(agents(page)).not.toContainText(/couldn|error|stopped|try again/i);
    await captureEachWidth(page, 'activity format failed', bandsReady);
  });

  test('activity long values: a 300-character word stays inside its band at 320 pixels', async ({
    page,
  }) => {
    const word = 'a'.repeat(300);
    await scriptFeeds(page, {
      fleet: { connections: [[...READY_FLEET, REPLAY_COMPLETE]] },
      bureau: {
        connections: [
          [
            envelope('b:1', 'chat.started', minutesAgo(16), { label: 'chat' }),
            envelope('b:2', 'review.requested', minutesAgo(6), { label: 'long' }),
            REPLAY_COMPLETE,
          ],
        ],
      },
    });
    await wordEvents(
      page,
      new Map<string, Wording>([
        ...READY_WORDS,
        ['long', { title: word, body: word, tier: 'warning', link: '/reviews' }],
      ]),
    );
    await openHome(page, 320);
    await expect(rowsOf(agents(page))).toHaveCount(2);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const long = await readBoxes(page, {
      band: agents(page),
      row: rowsOf(agents(page)).first(),
    });
    expect(long.row.x + long.row.width).toBeLessThanOrEqual(long.band.x + long.band.width + 1);
    const ready = async (current: Page) => {
      await expect(rowsOf(agents(current))).toHaveCount(2);
    };
    await captureEachWidth(page, 'activity long values', ready);
  });

  test('activity one beside full: a short band keeps its own height', async ({ page }) => {
    await scriptFeeds(page, {
      fleet: { connections: [[READY_FLEET[2]!, REPLAY_COMPLETE]] },
      bureau: { connections: [[...READY_AGENTS, REPLAY_COMPLETE]] },
    });
    await wordEvents(page, READY_WORDS);
    await openHome(page, 1280);
    await expect(rowsOf(workflow(page))).toHaveCount(1);
    await expect(rowsOf(agents(page))).toHaveCount(3);
    const heights = await readBoxes(page, { short: workflow(page), full: agents(page) });
    expect(heights.short.height).toBeLessThan(heights.full.height);
    const ready = async (current: Page) => {
      await expect(rowsOf(workflow(current))).toHaveCount(1);
      await expect(rowsOf(agents(current))).toHaveCount(3);
    };
    await captureEachWidth(page, 'activity one beside full', ready);
  });

  test('activity empty: each band says it has nothing yet, in one line', async ({ page }) => {
    await scriptFeeds(page, {
      fleet: { connections: [[REPLAY_COMPLETE]] },
      bureau: { connections: [[REPLAY_COMPLETE]] },
    });
    await openHome(page, 1280);
    const ready = async (current: Page) => {
      await expect(workflow(current).getByRole('heading', { level: 3 })).toHaveText(
        'No workflow activity yet',
      );
      await expect(agents(current).getByRole('heading', { level: 3 })).toHaveText(
        'No agent activity yet',
      );
    };
    await ready(page);
    await expect(workflow(page)).toContainText(
      'Workflow runs, steps and workers appear here as they happen.',
    );
    await expect(agents(page)).toContainText(
      'Chats, reviews, goals, schedules and hooks appear here as they happen.',
    );
    await captureEachWidth(page, 'activity empty', ready);
  });

  test('activity loading: before a band’s first window it holds three placeholder rows', async ({
    page,
  }) => {
    await scriptFeeds(page, { fleet: { hold: true }, bureau: { hold: true } });
    await openHome(page, 1280);
    const ready = async (current: Page) => {
      await expect(workflow(current).locator('.cinder-skeleton-grouped-row')).toHaveCount(3);
      await expect(agents(current).locator('.cinder-skeleton-grouped-row')).toHaveCount(3);
    };
    await ready(page);
    await expect(workflow(page).locator('.cinder-skeleton-grouped-leading')).toHaveCount(3);
    await expect(workflow(page).locator('.cinder-skeleton-trailing-bar')).toHaveCount(3);
    await captureEachWidth(page, 'activity loading', ready);
  });

  test('activity still loading: after 10 s a band says so above its placeholders', async ({
    page,
  }) => {
    await page.clock.install({ time: SAMPLE_NOW_MILLISECONDS });
    await scriptFeeds(page, { fleet: { hold: true }, bureau: { hold: true } });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    await expect(page.getByTestId('home-counts')).toBeVisible();
    await expect(workflow(page).locator('.cinder-skeleton-grouped-row')).toHaveCount(3);
    await page.clock.runFor(10_000);
    const ready = async (current: Page) => {
      await expect(workflow(current).locator('.cinder-skeleton-status')).toHaveText(
        'Still loading workflow activity. This is taking longer than usual.',
      );
      await expect(agents(current).locator('.cinder-skeleton-status')).toHaveText(
        'Still loading agent activity. This is taking longer than usual.',
      );
    };
    await ready(page);
    await captureEachWidth(page, 'activity still loading', ready);
  });

  test('activity one band failed: it says so in its own place, and the other band stays live', async ({
    page,
  }) => {
    await scriptFeeds(page, {
      fleet: { refuse: 503 },
      bureau: { connections: [[...READY_AGENTS, REPLAY_COMPLETE]] },
    });
    await wordEvents(page, READY_WORDS);
    await openHome(page, 1280);
    const ready = async (current: Page) => {
      await expect(workflow(current).getByTestId('home-card-error')).toBeVisible();
      await expect(rowsOf(agents(current))).toHaveCount(3);
    };
    await ready(page);
    await expect(workflow(page)).toContainText('Couldn’t load workflow activity.');
    await expect(workflow(page)).toContainText('The rest of Home is live.');
    await expect(workflow(page).getByRole('button', { name: 'Try again' })).toBeVisible();
    await captureEachWidth(page, 'activity one band failed', ready);
  });

  test('activity after resync: the window replaces the rows in one step, keeping a row still in it', async ({
    page,
  }) => {
    await scriptFeeds(page, {
      fleet: { connections: [[...READY_FLEET, REPLAY_COMPLETE]] },
      bureau: {
        connections: [
          [...READY_AGENTS, REPLAY_COMPLETE],
          // What the reconnect replays after its cursor, which the source holds back.
          [
            envelope('b:4', 'chat.started', minutesAgo(3), { label: 'chat-two' }),
            envelope('b:5', 'run.settled', minutesAgo(2), { label: 'settled' }),
            REPLAY_COMPLETE,
          ],
        ],
      },
    });
    await wordEvents(
      page,
      new Map<string, Wording>([
        ...READY_WORDS,
        ['chat-two', { title: 'Chat started with Researcher', icon: 'message-square' }],
        ['settled', { title: 'Release notes digest finished', icon: 'workflow' }],
      ]),
    );
    await openHome(page, 1280);
    await bandsReady(page);
    await page.evaluate(() => window.__activityFeeds?.drop('bureau'));
    const titles = rowsOf(agents(page)).locator('.cinder-grouped-list-item__title');
    await expect(titles).toHaveText([
      'Release notes digest finished',
      'Chat started with Researcher',
      /^Tool runner asks to refund order 4471/,
    ]);
    // Replaced, not added one by one: nothing fades in.
    await expect(agents(page).locator('.cinder-grouped-list-item--arriving')).toHaveCount(0);
    const ready = async (current: Page) => {
      await expect(rowsOf(agents(current)).first()).toContainText('Release notes digest finished');
    };
    await captureEachWidth(page, 'activity after resync', ready);
  });
});

/**
 * F7-26: following a row's link leaves Home with no page error while its rows are held. Focus is
 * on the review row's link and an arrival for each band waits under the hold when the link is
 * followed. Chromium fires `focusout` as Home is removed, inside the router's block effect, where a
 * state write throws Svelte's `state_unsafe_mutation`; the page-error fixture fails the test on it.
 */
async function holdArrivalsOnReviewLink(page: Page, width: number) {
  await scriptFeeds(page, {
    fleet: { connections: [[...READY_FLEET, REPLAY_COMPLETE]] },
    bureau: { connections: [[...READY_AGENTS, REPLAY_COMPLETE]] },
  });
  await wordEvents(page, READY_WORDS);
  await openHome(page, width);
  await bandsReady(page);
  const link = rowsOf(agents(page)).first().getByRole('link');
  await link.focus();
  const worded = page.waitForResponse(
    (response) =>
      response.url().endsWith('/bureau/jsonrpc') &&
      (response.request().postData() ?? '').includes('"held-arrival"'),
  );
  await page.evaluate(
    ([fleetChunk, bureauChunk]) => {
      window.__activityFeeds?.push('fleet', fleetChunk);
      window.__activityFeeds?.push('bureau', bureauChunk);
    },
    [
      envelope('f:5', 'workflow:completed', minutesAgo(0), { workflowId: 'digest-1103' }),
      envelope('b:4', 'chat.started', minutesAgo(0), { label: 'held-arrival' }),
    ] as const,
  );
  await worded;
  // Focus holds Agent activity's rows: the arrival waits under the review row.
  await expect(rowsOf(agents(page)).first()).toHaveAttribute(
    'title',
    /^Tool runner asks to refund order 4471/,
  );
  return link;
}

test.describe('Home activity: following a held row (COR-2227, F7-26)', () => {
  test('activity followed by Enter at 1280: Home is left with no page error', async ({ page }) => {
    await holdArrivalsOnReviewLink(page, 1280);
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/reviews$/);
    await page.goBack();
    await bandsReady(page);
  });

  test.describe('on a touch screen', () => {
    test.use({ hasTouch: true, isMobile: true });

    test('activity followed by a tap at 375: Home is left with no page error', async ({ page }) => {
      const link = await holdArrivalsOnReviewLink(page, 375);
      await link.tap();
      await expect(page).toHaveURL(/\/reviews$/);
      await page.goBack();
      await bandsReady(page);
    });
  });
});
