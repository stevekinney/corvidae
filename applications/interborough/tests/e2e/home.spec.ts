/**
 * Home (`/`) on the sample world (`fixtures/sample-world-seed.ts`, the showcase host) at the
 * browser's sample clock, Monday, Nov 2, 10:46 AM Central time: the overview of what needs you and
 * what needs attention (COR-2016, design rows 01a to 01k, 01s to 01v; COR-2329 replaces row 01d's
 * four counts with one Spotlight and one count). The date line, the Spotlight and the count under
 * it, the two reviews waiting on the person, the three system problems, the box that starts a chat
 * and the chats last in are each read as the design words them.
 *
 * Captioned states the sample world does not hold are made by answering the Bureau's own
 * operations with what a different world would answer (`answerBureau`), so the screen is the one
 * the real application draws, and each is captured for the design review under its own name: a
 * host with no storage rule (Needs attention has two rows), a person with nothing to review (the
 * Spotlight says nothing needs you, and the sections read as caught up), a run going (rows 01w and 01x), and a new
 * installation that lists Assistant, the first-run checklist (rows 01y to 02b, 13c to 13j, 14c to
 * 14j). The fresh installation's own host lists no Assistant, so `first-run.spec.ts` reads the
 * checklist there as it completes and without one.
 */
import type { Locator, Page, Route } from '@playwright/test';

import {
  SAMPLE_NOW,
  SAMPLE_NOW_MILLISECONDS,
  SAMPLE_TIME_ZONE,
} from '../../fixtures/sample-now.ts';
import { SAMPLE_WORLD_THREADS } from '../../fixtures/sample-world-records.ts';
import {
  humanInputAnsweredReply,
  toolRunnerRefundedReply,
} from '../../src/host/showcase-sentences.ts';
import {
  captureForDesignReview,
  captureForDesignReviewWithPhone,
  DESIGN_REVIEW_PHONE,
} from './design-review-capture.ts';
import { E2E_JOURNEY_URL, E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, holdBureauFeed, test } from './fixtures.ts';
import { touchHeight } from './hit-area.ts';
import { readBoxes } from './read-boxes.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'home.spec.ts';

/** Opens Home at `width` and waits until the cards that read the Bureau hold their rows. */
async function openHome(page: Page, width = 1280): Promise<void> {
  await page.clock.setFixedTime(SAMPLE_NOW);
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/');
  await expect(page.locator('[data-page="home"][data-mode="overview"]')).toBeVisible();
  await expect(page.locator('[data-home-card="Recent chats"] li').first()).toBeVisible();
}

/**
 * Answers the named Bureau operations with `change`'s version of what the host answered, and leaves
 * every other operation to the host. `change` receives the real result, so the shape is the host's
 * own and only what the state is about differs.
 */
async function answerBureau(
  page: Page,
  changes: Readonly<Record<string, (result: unknown, params: Record<string, unknown>) => unknown>>,
): Promise<void> {
  await page.route('**/jsonrpc', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as {
      id?: unknown;
      method?: string;
      params?: Record<string, unknown>;
    };
    const change = body.method === undefined ? undefined : changes[body.method];
    if (change === undefined) {
      await route.fallback();
      return;
    }
    // A page that navigates away while the host is still answering disposes the response; the
    // request is then of no use to anyone.
    try {
      const response = await route.fetch();
      const answer = (await response.json()) as { result?: unknown };
      await route.fulfill({
        response,
        json: { ...answer, result: change(answer.result, body.params ?? {}) },
      });
    } catch {
      await route.abort().catch(() => undefined);
    }
  });
}

/**
 * What the host answers once every decision is made: no review waits, nothing needs attention, and
 * each chat is idle with the outcome its scripted agent says once the decision is made
 * (`showcase-sentences.ts`): each refund chat once its refund is approved, and the release chat once
 * it is answered, each found by its thread. A chat that is not waiting on anything reads Done, as it
 * does in a real world where its review has been decided.
 */
const everythingDecided = {
  'bureau.reviews.list': (result: unknown) => ({ ...(result as object), reviews: [] }),
  'bureau.health.attention': () => ({ items: [], count: 0, checks: [] }),
  'bureau.contexts.list': (result: unknown) => {
    const answer = result as { contexts: Record<string, unknown>[] };
    const outcomes = new Map<unknown, string>([
      [SAMPLE_WORLD_THREADS.refund, toolRunnerRefundedReply(4200)],
      [SAMPLE_WORLD_THREADS.refund4472, toolRunnerRefundedReply(1850)],
      [SAMPLE_WORLD_THREADS.release, humanInputAnsweredReply('Staging')],
    ]);
    return {
      ...answer,
      contexts: answer.contexts.map((context) => {
        const outcome = outcomes.get(context['id']);
        return {
          ...context,
          activity: 'idle',
          ...(outcome === undefined ? {} : { lastMessagePreview: outcome }),
        };
      }),
    };
  },
};

const needsYou = (page: Page) => page.locator('[data-home-card="Needs you"]');

test('wide Home keeps attention actions in the content bound', async ({ page }) => {
  await openHome(page);
  const home = page.locator('[data-page="home"][data-mode="overview"]');
  const outlet = page.locator('main.weft-shell-outlet');
  const rows = home.getByRole('list', { name: 'System problems' }).getByRole('listitem');
  const destinations = [
    ['Review storage', '/health/storage'],
    ['View schedule', /^\/schedules\/[^/?]+$/],
    ['Connect a provider', '/settings/models'],
  ] as const;

  const checkAttention = async () => {
    await expect(rows).toHaveCount(destinations.length);
    for (const [index, [label, destination]] of destinations.entries()) {
      const row = rows.nth(index);
      const action = row.getByRole('link', { name: label, exact: true });
      await expect(row.getByRole('link')).toHaveCount(1);
      await expect(action).toHaveAttribute('href', destination);
      const boxes = await readBoxes(page, { home, row, action });
      expect(boxes.row.x).toBeGreaterThanOrEqual(boxes.home.x);
      expect(boxes.row.x + boxes.row.width).toBeLessThanOrEqual(boxes.home.x + boxes.home.width);
      expect(boxes.action.x).toBeGreaterThanOrEqual(boxes.row.x);
      expect(boxes.action.x + boxes.action.width).toBeLessThanOrEqual(
        boxes.row.x + boxes.row.width,
      );
      expect(boxes.action.y).toBeGreaterThanOrEqual(boxes.row.y);
      expect(boxes.action.y + boxes.action.height).toBeLessThanOrEqual(
        boxes.row.y + boxes.row.height,
      );
    }
  };

  await checkAttention();
  const available = await outlet.evaluate((element) => {
    const style = getComputedStyle(element);
    return element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  });
  const at1280 = await readBoxes(page, { home });
  expect(at1280.home.width).toBe(available);

  await page.setViewportSize({ width: 1920, height: 1080 });
  await checkAttention();
  const at1920 = await readBoxes(page, { home });
  expect(at1920.home.x).toBe(at1280.home.x);
  expect(at1920.home.width).toBe(1152);

  await page.setViewportSize({ width: 1280, height: 900 });
  await captureForDesignReview(page, {
    route: '/',
    state: 'bounded-attention',
    source: SOURCE,
    ready: checkAttention,
  });

  for (const [index, [label, destination]] of destinations.entries()) {
    await rows.nth(index).getByRole('link', { name: label, exact: true }).click();
    await expect(page).toHaveURL((url) =>
      typeof destination === 'string'
        ? url.pathname === destination
        : destination.test(url.pathname),
    );
    await page.goBack();
    await expect(page).toHaveURL((url) => url.pathname === '/');
  }
});

test.describe('Home attention on a touch phone', () => {
  test.use({ hasTouch: true, isMobile: true });

  for (const width of [320, 375] as const) {
    test(`wide Home keeps attention actions in the content bound at ${width}px`, async ({
      page,
    }) => {
      await openHome(page, width);
      const outlet = page.locator('main.weft-shell-outlet');
      const rows = outlet.getByRole('list', { name: 'System problems' }).getByRole('listitem');
      await expect(rows.getByRole('link')).toHaveCount(3);
      const overflow = await outlet.evaluate((element) => ({
        page: document.documentElement.scrollWidth - innerWidth,
        outlet: element.scrollWidth - element.clientWidth,
      }));
      expect(overflow.page).toBeLessThanOrEqual(0);
      expect(overflow.outlet).toBeLessThanOrEqual(0);
    });
  }
});

test.describe('Home on the sample world, with something waiting on you', () => {
  test('is the page at /, with no visible heading and the date line leading (01a, 01b, 01c)', async ({
    page,
  }) => {
    await openHome(page);
    await expect(
      page.getByRole('navigation', { name: 'Views' }).getByRole('link').first(),
    ).toHaveText('Home');
    await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toHaveClass(
      /cinder-sr-only/,
    );
    await expect(page.getByTestId('home-date')).toHaveText(
      'Monday, Nov 2. Times show in Central time (CST).',
    );
  });

  // COR-2329 reverses row 01d (owner, 2026-11-13): one Spotlight, not four tiles. Owner,
  // 2026-11-19: a count shows only when it is not zero, so the sample world's no failed runs is no
  // tile at all.
  test('leads with one Spotlight, 2 need you, its list under it, and no count at zero', async ({
    page,
  }) => {
    await openHome(page);
    const spotlight = page.getByTestId('home-spotlight').locator('.cinder-spotlight__value');
    await expect(spotlight).toHaveText('2 need you');
    await expect(page.getByTestId('home-counts')).toHaveCount(0);
    await expect(page.locator('main .cinder-statistic')).toHaveCount(0);
    const boxes = await readBoxes(page, { spotlight, list: needsYou(page) });
    expect(boxes.list.y).toBeGreaterThan(boxes.spotlight.y + boxes.spotlight.height - 1);
  });

  test('shows the positive failed-run count after Needs you at wide and phone widths', async ({
    page,
  }) => {
    await answerBureau(page, {
      'weft.workflows.aggregate': () => ({ total: 3, groups: [], truncated: false }),
    });
    await openHome(page);
    const ready = async (current: Page) => {
      const counts = current.getByTestId('home-counts');
      await expect(counts).toContainText('Failed in 24 hours');
      await expect(counts).toContainText('3');
      const boxes = await readBoxes(current, { list: needsYou(current), counts });
      expect(boxes.counts.y).toBeGreaterThan(boxes.list.y + boxes.list.height);
    };
    await ready(page);
    await captureForDesignReviewWithPhone(page, {
      route: '/',
      state: 'failed runs count',
      source: SOURCE,
      ready,
    });
    await page.setViewportSize(DESIGN_REVIEW_PHONE);
    await ready(page);
  });

  // Owner, 2026-11-19: the left column and Start a chat ended at different heights with a dead
  // band before Recent chats. Recent chats follows Start a chat in the narrow column, so no section
  // waits under a short Start a chat, and the gaps are one value.
  for (const width of [1920, 1280] as const) {
    test(`aligns both columns with Recent chats under Start a chat at ${width} pixels`, async ({
      page,
    }) => {
      await openHome(page, width);
      const boxes = await readBoxes(page, {
        main: page.locator('.ib-home__main'),
        aside: page.locator('.ib-home__aside'),
        start: page.getByTestId('home-start-chat'),
        recent: page.locator('[data-home-card="Recent chats"]'),
        needsYou: needsYou(page),
        attention: page.locator('[data-home-card="Needs attention"]'),
      });
      // Two columns side by side, the chat sections in the narrow one.
      expect(boxes.aside.x).toBeGreaterThan(boxes.main.x + boxes.main.width - 1);
      expect(Math.abs(boxes.recent.x - boxes.start.x)).toBeLessThan(2);
      // One gap between sections, 32px, in either column.
      const gapAside = boxes.recent.y - (boxes.start.y + boxes.start.height);
      const gapMain = boxes.attention.y - (boxes.needsYou.y + boxes.needsYou.height);
      expect(Math.abs(gapAside - 32)).toBeLessThanOrEqual(1);
      expect(Math.abs(gapMain - 32)).toBeLessThanOrEqual(1);
      const mainEnd = boxes.attention.y + boxes.attention.height;
      const asideEnd = boxes.recent.y + boxes.recent.height;
      expect(Math.abs(mainEnd - asideEnd)).toBeLessThanOrEqual(1);
    });
  }

  test('lists the two reviews waiting on you, oldest first, kind first on line two (01f, 01g)', async ({
    page,
  }) => {
    await openHome(page);
    const card = needsYou(page);
    const rows = card.getByRole('listitem');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Which environment should the release go to?');
    await expect(rows.nth(0)).toContainText('Question, Request human input, 1 h ago');
    await expect(rows.nth(0).getByRole('link', { name: 'Answer' })).toBeVisible();
    await expect(rows.nth(1)).toContainText('Refund order 4471 for $42.00?');
    await expect(rows.nth(1)).toContainText('Approval, Tool runner, Can’t be undone, 4 min ago');
    await expect(rows.nth(1).getByRole('link', { name: 'Review' })).toBeVisible();
    // COR-2329: the Spotlight is the list's title, so the list has no heading of its own, and
    // "Open Reviews" sits beside the Spotlight, ending where the list does.
    await expect(card.getByRole('heading')).toHaveCount(0);
    await expect(card.getByRole('list', { name: 'Reviews waiting on you' })).toBeVisible();
    const open = page.getByTestId('home-focus').getByRole('link', { name: 'Open Reviews' });
    await expect(open).toHaveAttribute('href', '/reviews');
    await expect(page.getByRole('link', { name: 'Open Reviews' })).toHaveCount(1);
    const [spotlightBox, openBox, listBox] = await Promise.all([
      page.getByTestId('home-spotlight').boundingBox(),
      open.boundingBox(),
      card.boundingBox(),
    ]);
    expect(openBox!.y).toBeGreaterThanOrEqual(spotlightBox!.y - 1);
    expect(openBox!.y + openBox!.height).toBeLessThanOrEqual(
      spotlightBox!.y + spotlightBox!.height + 1,
    );
    expect(
      Math.abs(openBox!.x + openBox!.width - (listBox!.x + listBox!.width)),
    ).toBeLessThanOrEqual(1);
    // The link is quieter than the Spotlight and the section headings: small regular text.
    const [linkSize, headingSize] = await Promise.all([
      open.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
      page
        .getByRole('heading', { level: 2, name: 'Needs attention' })
        .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
    ]);
    expect(linkSize).toBeLessThan(headingSize);
    await expect(open).toHaveCSS('font-weight', '400');
    // Needs you leads: it sits above Needs attention.
    const attentionTop = await page
      .getByRole('heading', { level: 2, name: 'Needs attention' })
      .boundingBox();
    expect(listBox!.y).toBeLessThan(attentionTop!.y);
    await captureForDesignReviewWithPhone(page, {
      route: '/',
      state: 'open reviews link',
      source: SOURCE,
    });
  });

  test('lists the three system problems, each with one button, and no provider banner (01h, 01i, 01j)', async ({
    page,
  }) => {
    await openHome(page);
    const rows = page.getByRole('list', { name: 'System problems' }).getByRole('listitem');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('Storage is over its warning level');
    await expect(rows.nth(0)).toContainText('1.6 GB used');
    await expect(rows.nth(0).getByRole('link', { name: 'Review storage' })).toBeVisible();
    await expect(rows.nth(1)).toContainText('Daily summary missed 4 runs since Oct 30');
    await expect(rows.nth(1)).toContainText(
      'Schedule, Assistant, Every day at 3:00 AM (9:00 AM UTC)',
    );
    await expect(rows.nth(1).getByRole('link', { name: 'View schedule' })).toBeVisible();
    await expect(rows.nth(2)).toContainText('No model provider connected');
    await expect(rows.nth(2)).toContainText(
      'Model agents can’t answer until one is connected. Assistant works now.',
    );
    await expect(rows.nth(2).getByRole('link', { name: 'Connect a provider' })).toBeVisible();
    // The storage row states a reading and never a capacity or a threshold.
    await expect(rows.nth(0)).not.toContainText(/threshold|capacity|limit/i);
    // The third row is the only provider notice: no banner says it again.
    await expect(page.locator('main').getByRole('alert')).toHaveCount(0);
    await expect(page.getByText('Connect a model provider')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Open Health' })).toHaveAttribute(
      'href',
      '/health',
    );
  });

  test('puts Start a chat beside both lists, with a message box, a ghost Agent select and a live Send (01k)', async ({
    page,
    checkA11y,
  }) => {
    await openHome(page);
    const card = page.getByTestId('home-start-chat');
    await expect(card.getByRole('heading', { level: 2, name: 'Start a chat' })).toBeVisible();
    await expect(card.getByPlaceholder('Ask an agent to do something')).toBeVisible();
    const agent = card.getByRole('combobox', { name: 'Agent' });
    await expect(agent).toContainText('Assistant');
    await expect(card.locator('.cinder-select.select-variant-ghost').first()).toBeVisible();
    const send = card.getByRole('button', { name: 'Send' });
    await expect(send).toBeEnabled();
    await expect(send).toContainClass('button-variant-primary');
    await expect(send.locator('svg')).toBeVisible();
    // It is a right column: its left edge is past both lists'.
    const start = await card.boundingBox();
    const waiting = await needsYou(page).boundingBox();
    expect(start!.x).toBeGreaterThan(waiting!.x + waiting!.width - 1);
    await captureForDesignReviewWithPhone(page, {
      route: '/',
      state: 'something needs you',
      source: SOURCE,
    });
    await checkA11y('Home with something waiting on you');
  });

  test('lists the chats last in, with a status word, the latest message and the time (01l)', async ({
    page,
  }) => {
    await openHome(page);
    const rows = page.getByRole('list', { name: 'Recent chats' }).getByRole('listitem');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('Waiting on you');
    await expect(rows.nth(0)).toContainText('Refund order 4471');
    // A chat that waits on an approval says what the agent said, and one that waits on a question
    // says the question.
    await expect(rows.nth(0)).toContainText(
      'I found order 4471 ($42.00). I need your approval to refund it.',
    );
    await expect(rows.nth(0)).toContainText('10:42 AM');
    // The 4472 refund is a chat of its own, done once it was approved at 10:33 AM, so it is the
    // second chat last in, ahead of the release question (9:46 AM) and Say hello (yesterday).
    await expect(rows.nth(1)).toContainText('Done');
    await expect(rows.nth(1)).toContainText('Refund order 4472');
    await expect(rows.nth(2)).toContainText('Which environment should the release go to?');
    await expect(rows.nth(2)).toContainText('Waiting on you');
  });
});

test('a host with no storage rule has two rows under Needs attention (01i)', async ({ page }) => {
  await answerBureau(page, {
    'bureau.health.attention': (result) => {
      const answer = result as { items: { kind: string }[] };
      const items = answer.items.filter((item) => item.kind !== 'alert');
      return { ...answer, items, count: items.length };
    },
  });
  await openHome(page);
  const rows = page.getByRole('list', { name: 'System problems' }).getByRole('listitem');
  await expect(rows).toHaveCount(2);
  await expect(page.getByText('Storage is over its warning level')).toHaveCount(0);
  await captureForDesignReview(page, {
    route: '/',
    state: 'no storage rule',
    source: SOURCE,
  });
});

test.describe('Home with nothing waiting and a provider connected', () => {
  test.beforeEach(async ({ page }) => {
    await answerBureau(page, everythingDecided);
    await page.route('**/host/providers', async (route) => {
      const response = await route.fetch();
      const answer = (await response.json()) as { providers?: Record<string, unknown>[] };
      await route.fulfill({
        response,
        json: {
          ...answer,
          providers: [
            ...(answer.providers ?? []),
            { name: 'anthropic', hasKey: true, connected: true },
          ].map((provider) => ({ ...provider, hasKey: true, connected: true })),
        },
      });
    });
  });

  // Owner, 2026-11-19: no card says nothing and no tile reads zero. Nothing waiting is one quiet
  // line, and the space goes to what has content.
  test('says nothing is waiting in one quiet line, with no tile, no card and Send live (01s, 01t, 01u, 01v)', async ({
    page,
    checkA11y,
  }) => {
    await openHome(page);
    await expect(page.getByTestId('home-nothing-needs-you')).toHaveText('Nothing needs you.');
    const columns = page.locator('.ib-home__columns');
    const chatColumn = columns.locator('.ib-home__aside');
    const boxes = await readBoxes(page, { columns, chatColumn });
    const contentCenter = boxes.columns.x + boxes.columns.width / 2;
    const chatCenter = boxes.chatColumn.x + boxes.chatColumn.width / 2;
    expect(Math.abs(contentCenter - chatCenter)).toBeLessThanOrEqual(1);
    await expect(page.getByTestId('home-spotlight')).toHaveCount(0);
    await expect(page.getByTestId('home-counts')).toHaveCount(0);
    await expect(page.locator('main .cinder-statistic')).toHaveCount(0);
    await expect(page.locator('[data-quiet-line]')).toHaveCount(1);
    await expect(
      page.getByRole('navigation', { name: 'Views' }).getByRole('link', { name: /^Reviews/ }),
    ).not.toContainText(/\d/);
    // Nothing needs attention, so the Health dot in the sidebar is green.
    await expect(
      page
        .getByRole('navigation', { name: 'Views' })
        .getByRole('link', { name: /^Health/ })
        .locator('.cinder-status-dot'),
    ).toHaveAttribute('data-cinder-status', 'success');
    // No second line says it again (COR-2329), and no Needs attention section says nothing.
    await expect(page.getByText('Nothing is waiting on you')).toHaveCount(0);
    await expect(needsYou(page)).toHaveCount(0);
    await expect(page.locator('[data-home-card="Needs attention"]')).toHaveCount(0);
    await expect(
      page.locator('main.weft-shell-outlet').getByText('Nothing needs attention'),
    ).toHaveCount(0);
    const rows = page.getByRole('list', { name: 'Recent chats' }).getByRole('listitem');
    await expect(rows.nth(0)).toContainText('Done');
    await expect(rows.nth(0)).toContainText(
      'You approved it. Refunded $42.00 to the original payment method.',
    );
    // The 4472 refund, approved at 10:33 AM, is a chat of its own, after the 4471 one.
    await expect(rows.nth(1)).toContainText('Done');
    await expect(rows.nth(1)).toContainText(
      'You approved it. Refunded $18.50 to the original payment method.',
    );
    await expect(rows.nth(2)).toContainText('You answered Staging.');
    await expect(
      page.getByTestId('home-start-chat').getByRole('button', { name: 'Send' }),
    ).toBeEnabled();
    await captureForDesignReviewWithPhone(page, {
      route: '/',
      state: 'nothing waiting',
      source: SOURCE,
    });
    await checkA11y('Home with nothing waiting');
  });
});

/** What the sample world's host answers a new installation: no chat, no agent of the person's own, and no problem but the provider. */
async function asNewInstallation(page: Page): Promise<void> {
  await answerBureau(page, {
    'bureau.contexts.list': (result) => ({ ...(result as object), contexts: [], nextOffset: null }),
    'bureau.reviews.list': (result) => ({ ...(result as object), reviews: [] }),
    'bureau.health.attention': () => ({
      items: [{ kind: 'no-provider', at: null, provider: null }],
      count: 1,
      checks: [],
    }),
    'bureau.agents.list': (result) => ({
      ...(result as object),
      agents: (result as { agents: { kind: string }[] }).agents.filter(
        (agent) => agent.kind === 'code',
      ),
    }),
  });
}

/** Opens Home and waits until the page holds its first-run checklist. */
async function openFirstRun(page: Page, width = 1280): Promise<void> {
  await page.clock.setFixedTime(SAMPLE_NOW);
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('home-first-run')).toBeVisible();
}

const checklist = (page: Page) => page.getByTestId('home-first-run');
const stepsOf = (page: Page) => checklist(page).locator('.cinder-steps__item');

test.describe('Home on a new installation that lists Assistant', () => {
  test.beforeEach(async ({ page }) => {
    await asNewInstallation(page);
  });

  // Owner, 2026-11-19: a first run is the steps alone, under one real heading at the page title's
  // size and one sentence, at the reading width and centred; no welcome line, no "Get started"
  // header, no counter, no Recent chats.
  test('is the three-step checklist alone, under one heading and one sentence (01y, 01z, 02a, 02b, 13c, 13d, 13f, 13g, 13h, 13j, 14c, 14d, 14e)', async ({
    page,
    checkA11y,
  }) => {
    await openFirstRun(page);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Set up Interborough' }),
    ).toBeVisible();
    await expect(page.locator('main').getByRole('heading')).toHaveCount(1);
    await expect(checklist(page).locator('.ib-home-first-run__lead')).toHaveText(
      'Connect a model, choose an agent, then say hello.',
    );
    await expect(page.getByTestId('home-date')).toHaveCount(0);
    await expect(page.getByText(/^Welcome\./)).toHaveCount(0);
    await expect(page.getByText('Get started', { exact: true })).toHaveCount(0);
    await expect(checklist(page)).not.toContainText('of 3 done');
    const steps = stepsOf(page);
    await expect(steps).toHaveCount(3);
    await expect(steps.nth(0)).toContainText('Connect a provider');
    await expect(steps.nth(0)).toContainText(
      'Agents need a model provider before they can answer.',
    );
    await expect(steps.nth(1)).toContainText('Create an agent, or start from Assistant');
    await expect(steps.nth(1)).toContainText('Assistant works now; other agents need a provider.');
    await expect(steps.nth(2)).toContainText('Say hello');
    await expect(steps.nth(2)).toContainText('Send a first message to see a chat run end to end.');
    // Step 1's button is the only primary one; Use Assistant is the quiet link.
    await expect(checklist(page).locator('.cinder-button.button-variant-primary')).toHaveText([
      'Connect a provider',
    ]);
    await expect(steps.nth(1).getByRole('button', { name: 'Use Assistant' })).toContainClass(
      'button-variant-ghost-accent',
    );
    await expect(steps.nth(1).getByRole('link', { name: 'Create an agent' })).toContainClass(
      'button-variant-secondary',
    );
    // Step 3 is live with steps 1 and 2 open, and opens New chat with Assistant.
    const start = steps.nth(2).getByRole('link', { name: 'Start a chat' });
    await expect(start).toContainClass('button-variant-secondary');
    await expect(start).not.toHaveAttribute('aria-disabled', 'true');
    await expect(start).toHaveAttribute('href', /^\/chats\/new\?agent=[^&]*assistant$/);
    // Only the steps: no counts, Needs you, composer, Needs attention, Recent chats or empty state,
    // and no banner.
    await expect(page.getByTestId('home-counts')).toHaveCount(0);
    await expect(page.locator('[data-home-card]')).toHaveCount(0);
    await expect(page.getByTestId('home-start-chat')).toHaveCount(0);
    await expect(page.locator('main .cinder-empty-state')).toHaveCount(0);
    await expect(page.locator('main').getByRole('alert')).toHaveCount(0);
    await expect(page.getByText('Connect a model provider')).toHaveCount(0);
    // Every open step is a numbered circle: the upcoming ones draw their edge.
    for (const index of [1, 2]) {
      await expect(steps.nth(index).locator('.cinder-steps__marker')).not.toHaveCSS(
        'box-shadow',
        'none',
      );
    }
    await captureForDesignReview(page, { route: '/', state: 'first run', source: SOURCE });
    await checkA11y('Home on a new installation');
    await start.click();
    await expect(page).toHaveURL(/\/chats\/new\?agent=[^&]*assistant$/);
  });

  test('with a provider connected the checklist skips to step 2, and Use Assistant leaves one step (14e, 14j)', async ({
    page,
    checkA11y,
  }) => {
    await page.route('**/host/providers', async (route) => {
      const response = await route.fetch();
      const answer = (await response.json()) as { providers?: Record<string, unknown>[] };
      await route.fulfill({
        response,
        json: {
          ...answer,
          providers: [{ name: 'anthropic', configured: true, hasKey: true, connected: true }],
        },
      });
    });
    await openFirstRun(page);
    await expect(stepsOf(page).nth(0)).toContainText('Anthropic is connected.');
    await expect(
      stepsOf(page).nth(1).getByRole('link', { name: 'Create an agent' }),
    ).toContainClass('button-variant-primary');
    await stepsOf(page).nth(1).getByRole('button', { name: 'Use Assistant' }).click();
    await expect(stepsOf(page).nth(1)).toContainText('Assistant is ready to use.');
    await expect(stepsOf(page).nth(2).getByRole('link', { name: 'Start a chat' })).toContainClass(
      'button-variant-primary',
    );
    // The steps stay the whole page: the current step's action is the way to the first chat.
    await expect(page.getByTestId('home-start-chat')).toHaveCount(0);
    await expect(page.getByTestId('home-counts')).toHaveCount(0);
    await captureForDesignReview(page, {
      route: '/',
      state: 'first run, steps 1 and 2 done',
      source: SOURCE,
    });
    await checkA11y('Home after steps 1 and 2');
  });

  test('fits the checklist on a phone', async ({ page }) => {
    await openFirstRun(page, 390);
    await expect(stepsOf(page)).toHaveCount(3);
    await captureForDesignReview(page, { route: '/', state: 'first run', source: SOURCE });
  });

  // Owner, 2026-11-19: the steps filled two thirds of the width and left the rest empty. They sit
  // at the page's reading width, centred in the content area at every width from 768 up.
  for (const width of [768, 1280, 1920] as const) {
    test(`centres the first run at the reading width, with no box around it, at ${width} pixels`, async ({
      page,
    }) => {
      await openFirstRun(page, width);
      const geometry = await checklist(page).evaluate((block) => {
        const outlet = block.closest('main') as HTMLElement;
        const content = outlet.getBoundingClientRect();
        const style = getComputedStyle(outlet);
        const left = content.left + parseFloat(style.paddingLeft);
        const right = content.right - parseFloat(style.paddingRight);
        const box = block.getBoundingClientRect();
        const reading = parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue(
            '--cinder-content-width-reading',
          ),
        );
        return {
          leftGap: box.left - left,
          rightGap: right - box.right,
          width: box.width,
          readingPixels: reading * parseFloat(getComputedStyle(document.documentElement).fontSize),
          available: right - left,
          border: getComputedStyle(block).borderTopWidth,
          background: getComputedStyle(block).backgroundColor,
        };
      });
      expect(Math.abs(geometry.leftGap - geometry.rightGap)).toBeLessThanOrEqual(2);
      expect(geometry.width).toBeLessThanOrEqual(
        Math.min(geometry.readingPixels, geometry.available) + 1,
      );
      expect(geometry.border).toBe('0px');
      expect(geometry.background).toBe('rgba(0, 0, 0, 0)');
    });
  }

  test('shows neither activity band while the checklist shows (COR-2227, F7-07)', async ({
    page,
  }) => {
    for (const width of [1280, 375]) {
      await openFirstRun(page, width);
      await expect(stepsOf(page)).toHaveCount(3);
      await expect(page.locator('[data-page="home"]')).toHaveAttribute('data-mode', 'checklist');
      await expect(page.getByTestId('home-activity')).toHaveCount(0);
      await expect(page.locator('[data-home-card="Workflow activity"]')).toHaveCount(0);
      await expect(page.locator('[data-home-card="Agent activity"]')).toHaveCount(0);
      // The checklist is the page's only region.
      await expect(page.locator('[data-page="home"] > *')).toHaveCount(1);
    }
  });
});

test.describe('Home with a run going', () => {
  test('lists the run under Needs you, its status leading line two (01w, 01x)', async ({
    page,
    checkA11y,
  }) => {
    // A run the Daily summary schedule started at 10:44 AM, shaped as the Bureau shapes a task:
    // the first task the host lists, made a working one a schedule started.
    const listed = async <Result>(method: string, params: object): Promise<Result> => {
      const response = await page.request.post('/bureau/jsonrpc', {
        data: { jsonrpc: '2.0', id: method, method, params },
      });
      return ((await response.json()) as { result: Result }).result;
    };
    const { schedules } = await listed<{ schedules: { id: string; description: string | null }[] }>(
      'bureau.schedules.list',
      {},
    );
    const daily = schedules.find((schedule) => schedule.description === 'Daily summary');
    expect(daily, 'the sample world has a Daily summary schedule').toBeDefined();
    const { tasks } = await listed<{ tasks: Record<string, unknown>[] }>('bureau.tasks.list', {
      limit: 1,
    });
    const task = {
      ...tasks[0],
      id: 'running-daily-summary',
      agentName: 'assistant',
      actor: 'system:scheduler',
      kind: 'schedule-fire',
      origin: { kind: 'schedule', scheduleId: daily?.id },
      status: 'working',
      finishReason: null,
      statusMessage: null,
      createdAt: '2026-11-02T10:44:00-06:00',
      updatedAt: '2026-11-02T10:45:00-06:00',
      openWaits: [],
    };
    await answerBureau(page, {
      'bureau.tasks.list': (result, params) =>
        params['status'] === 'working'
          ? { tasks: [task], nextPageToken: null }
          : params['status'] === 'submitted'
            ? { tasks: [], nextPageToken: null }
            : result,
      ...everythingDecided,
    });
    await openHome(page);
    const card = page.locator('[data-home-card="Running now"]');
    await expect(card.getByRole('heading', { level: 2, name: 'Running now' })).toBeVisible();
    const row = card.getByRole('listitem');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Daily summary');
    // Line two leads with the status, a dot and its word, then what started the run.
    const dot = row.locator('.cinder-grouped-list-item__subtitle .cinder-status-dot');
    await expect(dot).toHaveAttribute('data-cinder-status', 'info');
    await expect(dot).toHaveText('Running');
    await expect(row.locator('.cinder-grouped-list-item__subtitle')).toContainText(
      ', Schedule, Assistant, started 10:44 AM',
    );
    await expect(row.getByRole('link', { name: 'View run' })).toHaveAttribute(
      'href',
      '/runs/running-daily-summary',
    );
    await expect(card.getByRole('link', { name: 'Open Runs' })).toHaveAttribute('href', '/runs');
    // It sits under the one quiet line that says nothing waits (no list is drawn under it), and no
    // Needs attention section says nothing below it (owner, 2026-11-19).
    const waiting = await page.getByTestId('home-focus').boundingBox();
    const running = await card.boundingBox();
    expect(waiting!.y + waiting!.height).toBeLessThan(running!.y);
    await expect(page.locator('[data-home-card="Needs attention"]')).toHaveCount(0);
    // Needs you reads 0 and no chat waits on anything, so Recent chats says Done on every row.
    const chats = page.getByRole('list', { name: 'Recent chats' }).getByRole('listitem');
    await expect(chats).toHaveCount(3);
    await expect(chats.filter({ hasText: 'Waiting on you' })).toHaveCount(0);
    await expect(chats.filter({ hasText: 'Done' })).toHaveCount(3);
    await captureForDesignReview(page, { route: '/', state: 'running now', source: SOURCE });
    await checkA11y('Home with a run going');
  });
});

/** Holds the reads that decide Home's shape until the returned function is called. */
async function holdHomeReads(page: Page): Promise<() => void> {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = async (route: Route): Promise<void> => {
    await gate;
    await route.fallback().catch(() => undefined);
  };
  await page.route('**/jsonrpc', held);
  await page.route('**/host/providers', held);
  return release;
}

/**
 * Pins the page to the sample world's clock and stops it, so a timer fires only when the test runs
 * the clock (`page.clock.runFor`): the loading page's 300 ms and 10 s are then exact, and nothing
 * waits in real time.
 */
async function pausedClock(page: Page): Promise<void> {
  await page.clock.install({ time: SAMPLE_NOW_MILLISECONDS - 1_000 });
  await page.clock.pauseAt(SAMPLE_NOW);
}

const homeBody = (page: Page) => page.locator('[data-page="home"]');

test.describe('Home while it loads (02c, 02d, 02e, 02f)', () => {
  test('draws nothing for the first 300 ms, then placeholders in its real layout (02c, 02d)', async ({
    page,
    checkA11y,
  }) => {
    await pausedClock(page);
    const release = await holdHomeReads(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    // The page is mounted (its heading is for screen readers), and its body draws nothing yet.
    await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toHaveClass(
      /cinder-sr-only/,
    );
    await expect(homeBody(page)).toHaveCount(0);
    await page.clock.runFor(299);
    await expect(homeBody(page)).toHaveCount(0);
    await page.clock.runFor(1);
    const body = homeBody(page);
    await expect(body).toHaveAttribute('data-mode', 'loading');
    // The page region is marked busy.
    await expect(body).toHaveAttribute('aria-busy', 'true');
    // The date line and the section headings are real text.
    await expect(page.getByTestId('home-date')).toHaveText(
      'Monday, Nov 2. Times show in Central time (CST).',
    );
    // The Spotlight, the rows and the composer are placeholders; the count has none, since it is
    // shown only when it is not zero (owner, 2026-11-19).
    await expect(
      page
        .getByTestId('home-loading-focus')
        .locator('> .cinder-skeleton-status-place > .cinder-skeleton')
        .first(),
    ).toBeVisible();
    await expect(body.locator('.cinder-statistic')).toHaveCount(0);
    // The Needs you rows have no heading, as the loaded ones do: the Spotlight is their title.
    await expect(body.getByRole('heading', { level: 2 })).toHaveText([
      'Needs attention',
      'Start a chat',
      'Recent chats',
      'Workflow activity',
      'Agent activity',
    ]);
    // The rows are Cinder's grouped placeholders, in the grouped lists' own shape; the activity
    // bands' have a glyph block and a time bar (COR-2227).
    await expect(body.locator('.cinder-skeleton-group[data-cinder-variant="grouped"]')).toHaveCount(
      5,
    );
    await expect(body.getByRole('textbox')).toHaveCount(0);
    await expect(body.getByRole('listitem')).toHaveCount(0);
    // The skeleton shimmers, and is static under reduced motion (the suite's default).
    const animation = () =>
      page
        .locator('.cinder-skeleton')
        .first()
        .evaluate((element) => getComputedStyle(element).animationName);
    expect(await animation()).toBe('none');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    expect(await animation()).not.toBe('none');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    // COR-2329: the Spotlight's and the count's placeholders were taller than the text they stand
    // for, so every section moved up about 7px when the data arrived. Measured while the clock is
    // still stopped, before the slow-load line can appear above the placeholders.
    const sectionTops = async () =>
      Promise.all(
        [
          needsYou(page),
          page.getByRole('heading', { level: 2, name: 'Needs attention' }),
          page.getByRole('heading', { level: 2, name: 'Start a chat' }),
        ].map(async (locator) => (await locator.boundingBox())!.y),
      );
    const topsWhileLoading = await sectionTops();
    // Captures resize the viewport for their phone/full-height screenshots, so sample the loading
    // geometry before that observer-only work changes the shell's scroll position.
    await captureForDesignReviewWithPhone(page, { route: '/', state: 'loading', source: SOURCE });
    // The page settles its paint on animation frames, which a stopped clock never delivers.
    await page.clock.resume();
    await checkA11y('Home loading');

    // The page, once it has its answers, is laid out as the placeholders were.
    const before = await page.locator('[data-home-card="Start a chat"]').boundingBox();
    release();
    await expect(homeBody(page)).toHaveAttribute('data-mode', 'overview');
    await expect(homeBody(page)).not.toHaveAttribute('aria-busy', 'true');
    const after = await page.locator('[data-home-card="Start a chat"]').boundingBox();
    expect(Math.round(after!.x)).toBe(Math.round(before!.x));
    expect(Math.round(after!.width)).toBe(Math.round(before!.width));
    await expect(needsYou(page).getByRole('listitem')).toHaveCount(2);
    const topsLoaded = await sectionTops();
    for (const [index, name] of ['Needs you', 'Needs attention', 'Start a chat'].entries()) {
      expect(
        Math.abs(topsLoaded[index]! - topsWhileLoading[index]!),
        `${name} starts where its placeholder did`,
      ).toBeLessThanOrEqual(1);
    }
  });

  test('after 10 s the skeleton’s own status line offers Cancel, and Cancel says Loading canceled (02e, 02f)', async ({
    page,
  }) => {
    await pausedClock(page);
    await holdHomeReads(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeAttached();
    await page.clock.runFor(300);
    await expect(homeBody(page)).toHaveAttribute('data-mode', 'loading');
    // Where the real content is before the line: the date line and the section headings.
    const contentTops = async () =>
      Promise.all(
        [
          page.getByTestId('home-date'),
          page.getByRole('heading', { level: 2, name: 'Start a chat' }),
          page.getByRole('heading', { level: 2, name: 'Needs attention' }),
        ].map(async (locator) => (await locator.boundingBox())!.y),
      );
    const beforeLine = await contentTops();
    await page.clock.runFor(9_699);
    await expect(page.getByText('Still loading Home.')).toHaveCount(0);
    await page.clock.runFor(1);
    const status = page.locator('.cinder-skeleton-status');
    await expect(status).toContainText('Still loading Home. This is taking longer than usual.');
    await expect(status.getByRole('button', { name: 'Cancel' })).toContainClass(
      'button-variant-ghost',
    );
    // It is the skeleton's own line, in view, not a banner. It takes the Spotlight placeholder's
    // place, so nothing on the page moves when it appears (COR-2329 round two: inserted above the
    // page it moved the date line 40px, and again when the data arrived).
    await expect(page.getByRole('region', { name: 'Connection problem' })).toHaveCount(0);
    await expect(status).toBeInViewport();
    const withLine = await contentTops();
    for (const [index, name] of ['the date line', 'Start a chat', 'Needs attention'].entries()) {
      expect(Math.abs(withLine[index]! - beforeLine[index]!), `${name} stays`).toBeLessThanOrEqual(
        1,
      );
    }
    const date = await page.getByTestId('home-date').boundingBox();
    const line = await status.boundingBox();
    expect(line!.y).toBeGreaterThanOrEqual(date!.y + date!.height - 1);
    await expect(
      page.getByTestId('home-loading-focus').locator('.cinder-skeleton-status-place'),
    ).toContainText('Still loading Home.');
    await captureForDesignReviewWithPhone(page, {
      route: '/',
      state: 'still loading',
      source: SOURCE,
    });

    await status.getByRole('button', { name: 'Cancel' }).click();
    // The page keeps its date line, and says the load was canceled in place of the cards.
    await expect(homeBody(page)).toHaveAttribute('data-mode', 'canceled');
    await expect(page.getByTestId('home-date')).toHaveText(
      'Monday, Nov 2. Times show in Central time (CST).',
    );
    const canceled = page.getByTestId('home-canceled');
    await expect(canceled).toContainText('Loading canceled');
    await expect(canceled.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(page.locator('[data-home-card]')).toHaveCount(0);
    await captureForDesignReview(page, {
      route: '/',
      state: 'still loading, canceled',
      source: SOURCE,
    });
  });
});

test.describe('Home when one card cannot be read (01n, 01o)', () => {
  test('Needs attention says so in its own card with Try again, and every other card stays live', async ({
    page,
    checkA11y,
  }) => {
    // The event feed's catch-up asks every list again, which would heal the card at once; it is
    // held, so the failure stays on screen for the test to read.
    await holdBureauFeed(page);
    // Three things read the problems in this order: the sidebar's Health dot, the notification bell,
    // then Home's Needs attention section. The third fails.
    let reads = 0;
    let healed = false;
    await page.route('**/jsonrpc', async (route) => {
      const body = route.request().postDataJSON() as { id?: unknown; method?: string };
      if (body.method !== 'bureau.health.attention') {
        await route.fallback();
        return;
      }
      reads += 1;
      if (reads !== 3 || healed) {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        json: {
          jsonrpc: '2.0',
          id: body.id,
          error: {
            code: -32000,
            message: 'Unavailable',
            data: { weftCode: 'Unavailable', httpStatus: 503 },
          },
        },
      });
    });
    await openHome(page);
    const card = page.locator('[data-home-card="Needs attention"]');
    const failure = card.getByTestId('home-card-error');
    await expect(failure).toHaveText(
      /Couldn’t load system problems\.\s*The rest of Home is live\.\s*Try again/,
    );
    await expect(failure.getByRole('button', { name: 'Try again' })).toContainClass(
      'button-variant-secondary',
    );
    // One flat row inside the card: the card keeps its title, and has no link and no list.
    await expect(card.getByRole('heading', { level: 2, name: 'Needs attention' })).toBeVisible();
    await expect(card.getByRole('link')).toHaveCount(0);
    await expect(card.getByRole('listitem')).toHaveCount(0);
    // The Spotlight has a read of its own and is unchanged.
    await expect(page.getByTestId('home-spotlight').locator('.cinder-spotlight__value')).toHaveText(
      '2 need you',
    );
    // Needs you, Start a chat and Recent chats render normally.
    await expect(needsYou(page).getByRole('listitem')).toHaveCount(2);
    await expect(page.getByTestId('home-start-chat').getByRole('textbox')).toBeVisible();
    await expect(
      page.getByRole('list', { name: 'Recent chats' }).getByRole('listitem'),
    ).toHaveCount(3);
    await captureForDesignReviewWithPhone(page, {
      route: '/',
      state: 'one card fails',
      source: SOURCE,
    });
    await checkA11y('Home with one card failing');

    // Try again asks that card's read again.
    healed = true;
    await failure.getByRole('button', { name: 'Try again' }).click();
    await expect(card.getByRole('listitem')).toHaveCount(3);
    await expect(card.getByTestId('home-card-error')).toHaveCount(0);
  });
});

const HOST_REQUESTS = /\/(v1|bureau|api|host)\/|\/jsonrpc$/;
const REFUSED = /net::ERR_CONNECTION_REFUSED/;
/** What Home reads, and the server's health probe: the shell itself (who the caller is) is not cut off. */
const HOME_READS = /\/(jsonrpc|host\/providers|v1\/health)$/;

test.describe('Home when the server does not answer (02g, 02h, 02i, 02j)', () => {
  test('with data on screen, a banner over the old data names its age and counts down; only the controls that change something are held (02g, 02h, 02i)', async ({
    page,
    pageErrors,
  }) => {
    pageErrors.expectEvery({
      pattern: REFUSED,
      reason: 'the test takes the page’s network away on purpose',
    });
    // The page loads at 10:44 AM, two minutes before the sample "now".
    await page.clock.install({ time: SAMPLE_NOW_MILLISECONDS - 2 * 60_000 });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    await expect(needsYou(page).getByRole('listitem')).toHaveCount(2);
    await expect(
      page.locator('[data-home-card="Needs attention"]').getByRole('listitem'),
    ).toHaveCount(3);
    const message = page.getByRole('textbox', { name: 'Message' });
    await message.fill('What did I approve yesterday?');

    // From here a timer fires only when the test runs the clock.
    await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 500);
    await page.route(HOST_REQUESTS, (route) => route.abort('connectionrefused'));
    // The person comes back to the tab, which makes every read ask again: the one that finds the
    // server gone.
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
    const banner = page.getByRole('region', { name: 'Connection problem' });
    await expect(banner).toBeVisible();
    // The probes wait 1 s, then 2 s, then 4 s: the third attempt is 4 s away.
    await page.clock.runFor(1_000);
    await expect(banner).toContainText('Retrying in 2 s (attempt 2 of 8)');
    await page.clock.runFor(2_000);
    await expect(banner).toContainText(
      'Can’t reach the Interborough server. Showing what loaded as of 10:44 AM CST. Changes are off until it’s back. Retrying in 4 s (attempt 3 of 8).',
    );
    // One word for asking again in the banner, the failed row and the full-page error (COR-2489).
    await expect(banner.getByRole('button', { name: 'Try again' })).toBeVisible();
    // The banner sits under the top bar, above the page.
    const bannerBox = await banner.boundingBox();
    const topBar = await page.getByRole('banner').boundingBox();
    const date = await page.getByTestId('home-date').boundingBox();
    expect(bannerBox!.y).toBeGreaterThanOrEqual(topBar!.y + topBar!.height - 1);
    expect(bannerBox!.y + bannerBox!.height).toBeLessThanOrEqual(date!.y);

    // Old data keeps full contrast (never dimmed with opacity), and nothing is zeroed.
    await expect(page.getByTestId('home-spotlight').locator('.cinder-spotlight__value')).toHaveText(
      '2 need you',
    );
    const opacity = (locator: Locator) =>
      locator.first().evaluate((element) => {
        let node: Element | null = element;
        let product = 1;
        while (node !== null) {
          product *= Number(getComputedStyle(node).opacity);
          node = node.parentElement;
        }
        return product;
      });
    expect(await opacity(page.getByRole('heading', { level: 2, name: 'Needs attention' }))).toBe(1);
    expect(
      await opacity(needsYou(page).getByText('Which environment should the release go to?')),
    ).toBe(1);
    expect(await opacity(page.getByTestId('home-spotlight'))).toBe(1);
    // Only the controls that change something are inert. The row buttons only open a page, as
    // "Open Reviews" does, so they stay live (COR-2329: holding them drew grey chips beside a live
    // link to the same page).
    for (const [name, scope] of [
      ['Answer', needsYou(page)],
      ['Review', needsYou(page)],
      ['Review storage', page.locator('[data-home-card="Needs attention"]')],
      ['View schedule', page.locator('[data-home-card="Needs attention"]')],
      ['Connect a provider', page.locator('[data-home-card="Needs attention"]')],
    ] as const) {
      const control = scope.getByRole('link', { name, exact: true });
      await expect(control, `${name} stays live`).not.toHaveAttribute('aria-disabled', 'true');
      expect(await opacity(control), `${name} is not faded`).toBe(1);
    }
    await expect(page.getByRole('link', { name: 'Open Reviews' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    // The composer keeps what was typed; Assistant is still the agent, and the shell holds Send as
    // it holds every submit button: aria-disabled and still focusable, with the shell's reason as
    // its title, so a keyboard user reaches it. No note squeezes the footer (COR-2329).
    const composer = page.getByTestId('home-start-chat');
    await expect(message).toHaveValue('What did I approve yesterday?');
    await expect(composer.getByRole('combobox', { name: 'Agent' })).toContainText('Assistant');
    const send = composer.getByRole('button', { name: 'Send' });
    await expect(send).toHaveAttribute('aria-disabled', 'true');
    await expect(send).not.toHaveAttribute('disabled', /.*/);
    await expect(send).toHaveAttribute('title', 'Off until it’s back');
    await send.focus();
    await expect(send).toBeFocused();
    await expect(composer.getByText('Off until it’s back')).toHaveCount(0);
    await captureForDesignReview(page, {
      route: '/',
      state: 'couldn’t reach Interborough',
      source: SOURCE,
    });
  });

  test('with nothing loaded the full error state shows instead of the banner, never both, and says Try again (02j)', async ({
    page,
    pageErrors,
  }) => {
    pageErrors.expectEvery({
      pattern: REFUSED,
      reason: 'the test takes the page’s network away on purpose',
    });
    await page.route(HOME_READS, (route) => route.abort('connectionrefused'));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    const state = page.getByTestId('home-unreachable');
    await expect(state).toContainText('Server unreachable');
    await expect(state.getByRole('button', { name: 'Try again' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Connection problem' })).toHaveCount(0);
    await expect(page.locator('[data-home-card]')).toHaveCount(0);
    await expect(page.getByTestId('home-counts')).toHaveCount(0);
    await captureForDesignReview(page, {
      route: '/',
      state: 'couldn’t reach Interborough, nothing loaded',
      source: SOURCE,
    });

    // The server is back: Try again reads again, and Home is drawn.
    await page.unroute(HOME_READS);
    await state.getByRole('button', { name: 'Try again' }).click();
    await expect(page.locator('[data-page="home"][data-mode="overview"]')).toBeVisible();
    await expect(page.getByTestId('home-unreachable')).toHaveCount(0);
  });
});

test.describe('Home on a phone (05c, 05o, 05p, 05q)', () => {
  test.use({ hasTouch: true, isMobile: true });

  test('has a menu button, Home and three icon buttons, the Spotlight with no count at zero, and 44px buttons at their own width under each review (05c, 05o, 05p, 05q)', async ({
    page,
    checkA11y,
  }) => {
    await openHome(page, 375);
    const bar = page.getByRole('banner');
    await expect(bar.getByRole('button', { name: 'Open navigation' })).toBeVisible();
    await expect(
      bar.getByRole('navigation', { name: 'Breadcrumb' }).getByText('Home'),
    ).toBeVisible();
    for (const name of [/^Search everything/, /^Notifications/, 'Quick settings']) {
      await expect(bar.getByRole('button', { name })).toBeVisible();
    }
    // The visible page heading is dropped; an h1 stays for screen readers.
    await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toHaveClass(
      /cinder-sr-only/,
    );
    await expect(page.getByTestId('home-date')).toHaveText(
      'Monday, Nov 2. Times show in Central time (CST).',
    );
    // The Spotlight, and no count while nothing failed (owner, 2026-11-19: no tile reads zero).
    await expect(page.getByTestId('home-spotlight').locator('.cinder-spotlight__value')).toHaveText(
      '2 need you',
    );
    await expect(page.getByTestId('home-counts')).toHaveCount(0);
    // Needs you, oldest first: each button is 44px, under its text at its own width, from the
    // title's leading edge (COR-2329: a full-width button read as a page-wide pill).
    const rows = needsYou(page).getByRole('listitem');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Which environment should the release go to?');
    await expect(rows.nth(0)).toContainText('Question, Request human input');
    await expect(rows.nth(1)).toContainText('Refund order 4471 for $42.00?');
    await expect(rows.nth(1)).toContainText('Approval, Tool runner, Can’t be undone');
    for (const [index, name] of [
      [0, 'Answer'],
      [1, 'Review'],
    ] as const) {
      const row = await rows.nth(index).boundingBox();
      const button = rows.nth(index).getByRole('link', { name });
      const box = await button.boundingBox();
      const title = await rows
        .nth(index)
        .getByRole('link', { name: /Which environment|Refund order/ })
        .count();
      expect(title).toBeLessThanOrEqual(1);
      expect(await touchHeight(button), `${name} is 44px`).toBeGreaterThanOrEqual(44);
      const titleBox = await rows
        .nth(index)
        .locator('.cinder-grouped-list-item__title')
        .boundingBox();
      expect(box!.y, `${name} is under its text`).toBeGreaterThan(titleBox!.y);
      expect(box!.width, `${name} keeps its own width`).toBeLessThan(row!.width / 2);
      expect(Math.abs(box!.x - titleBox!.x), `${name} starts at the title`).toBeLessThanOrEqual(1);
    }
    await expect(needsYou(page).getByRole('button', { name: 'More actions' })).toHaveCount(0);
    // The phone's order: the Spotlight, Needs you, the composer card, then Needs attention and Recent chats.
    const tops = await Promise.all(
      [
        page.getByTestId('home-focus'),
        needsYou(page),
        page.getByTestId('home-start-chat'),
        page.locator('[data-home-card="Needs attention"]'),
        page.locator('[data-home-card="Recent chats"]'),
      ].map(async (locator) => (await locator.boundingBox())!.y),
    );
    expect(tops).toEqual(tops.toSorted((first, second) => first - second));
    expect(new Set(tops).size).toBe(5);
    // The page never scrolls sideways.
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await captureForDesignReview(page, { route: '/', state: 'phone', source: SOURCE });
    await checkA11y('Home on a phone');
  });

  // COR-2329 round two: full-width buttons read as page-wide pills; each keeps its own width now.
  test('drops each step’s actions under its text at their own width on a first run (05c)', async ({
    page,
  }) => {
    await asNewInstallation(page);
    await openFirstRun(page, 375);
    const steps = stepsOf(page);
    await expect(steps).toHaveCount(3);
    for (const index of [0, 1, 2]) {
      const step = await steps.nth(index).boundingBox();
      const text = await steps.nth(index).locator('.cinder-steps__body').boundingBox();
      const actions = steps.nth(index).locator('.cinder-steps__action').locator('a, button');
      const count = await actions.count();
      for (let item = 0; item < count; item += 1) {
        const button = actions.nth(item);
        // Not the quiet link, which is text in a line.
        if (
          await button.evaluate((element) =>
            element.classList.contains('button-variant-ghost-accent'),
          )
        )
          continue;
        const box = await button.boundingBox();
        expect(
          box!.y,
          `step ${String(index + 1)}'s button is under its text`,
        ).toBeGreaterThanOrEqual(text!.y + text!.height - 1);
        expect(box!.width, `step ${String(index + 1)}'s button keeps its own width`).toBeLessThan(
          step!.width / 2,
        );
        if (item === 0) {
          expect(
            Math.abs(box!.x - text!.x),
            `step ${String(index + 1)}'s first button starts at its text`,
          ).toBeLessThanOrEqual(1);
        }
      }
    }
    await captureForDesignReview(page, {
      route: '/',
      state: 'first run, phone',
      source: SOURCE,
    });
  });
});

test.describe('Home on a tablet (05s)', () => {
  test('keeps the tablet menu, full search, Spotlight and the buttons trailing their rows', async ({
    page,
    checkA11y,
  }) => {
    await openHome(page, 768);
    await expect(page.locator('aside.weft-shell-sidebar')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible();
    await expect(
      page.getByRole('banner').getByRole('button', { name: /^Search everything/ }),
    ).toContainText('⌘K');
    await expect(page.getByTestId('home-spotlight').locator('.cinder-spotlight__value')).toHaveText(
      '2 need you',
    );
    const rows = needsYou(page).getByRole('listitem');
    for (const [index, name] of [
      [0, 'Answer'],
      [1, 'Review'],
    ] as const) {
      const row = await rows.nth(index).boundingBox();
      const button = await rows.nth(index).getByRole('link', { name }).boundingBox();
      // The button trails its row: at the end, on the row's own line.
      expect(button!.x + button!.width).toBeGreaterThan(row!.x + row!.width - 40);
      expect(button!.width).toBeLessThan(row!.width / 3);
      expect(button!.y + button!.height).toBeLessThan(row!.y + row!.height + 1);
    }
    await captureForDesignReview(page, { route: '/', state: 'tablet', source: SOURCE });
    await checkA11y('Home on a tablet');
  });
});

// Sending starts a chat, which another specification's host would count. The journey host is opened
// by `90-journey.spec.ts` alone, which runs before this one, so a chat made here changes nothing
// anyone counts.
test.describe('Start a chat on the journey host', () => {
  test.use({ baseURL: E2E_JOURNEY_URL });

  // The journey host starts with no chat, and Home on a host with none is the first-run checklist
  // alone (owner, 2026-11-19), which holds Start a chat until its step. These two rows are about
  // the overview's Start a chat card, so the host lists one earlier chat; sending still goes to the
  // real host.
  test.beforeEach(async ({ page }) => {
    await answerBureau(page, {
      'bureau.contexts.list': (result) => ({
        ...(result as object),
        contexts: [
          {
            id: 'an-earlier-chat',
            owner: null,
            agentName: 'assistant',
            title: 'An earlier chat',
            lastMessagePreview: 'An earlier chat',
            parentContextId: null,
            forkedFromMessageId: null,
            messageCount: 1,
            createdAt: '2026-10-23T14:00:00.000Z',
            updatedAt: '2026-10-23T14:00:00.000Z',
            activity: 'idle',
          },
        ],
        nextOffset: null,
      }),
    });
  });

  test('sends the typed message as the first message of a new chat with the chosen agent (01k)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    const card = page.getByTestId('home-start-chat');
    await expect(card.getByRole('combobox', { name: 'Agent' })).toContainText('Assistant');
    await card.getByPlaceholder('Ask an agent to do something').fill('Hello from Home.');
    await card.getByRole('button', { name: 'Send' }).click();
    await expect(page).toHaveURL(/\/chats\/[^/?]+$/);
    await expect(page.getByText('Hello from Home.').first()).toBeVisible();
    // The first message is sent once: the new chat's address no longer carries it.
    expect(page.url()).not.toContain('message=');
  });

  test('with nothing typed, Send opens New chat with the agent alone (01k)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    await page.getByTestId('home-start-chat').getByRole('button', { name: 'Send' }).click();
    await expect(page).toHaveURL(/\/chats\/new\?agent=demo%3Aassistant$/);
  });
});
