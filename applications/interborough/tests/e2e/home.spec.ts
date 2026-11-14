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
import {
  humanInputAnsweredReply,
  toolRunnerRefundedReply,
} from '../../src/host/showcase-sentences.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_JOURNEY_URL, E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, holdBureauFeed, test } from './fixtures.ts';
import { touchHeight } from './hit-area.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'home.spec.ts';

/** Opens Home at `width` and waits until the cards that read the Bureau hold their rows. */
async function openHome(page: Page, width = 1280): Promise<void> {
  await page.clock.setFixedTime(SAMPLE_NOW);
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('home-counts')).toBeVisible();
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
  await page.route('**/bureau/jsonrpc', async (route) => {
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
 * (`showcase-sentences.ts`): the refund chat once the 4471 refund is approved, and the release chat
 * once it is answered. A chat that is not waiting on anything reads Done, as it does in a real
 * world where its review has been decided.
 */
const everythingDecided = {
  'bureau.reviews.list': (result: unknown) => ({ ...(result as object), reviews: [] }),
  'bureau.health.attention': () => ({ items: [], count: 0, checks: [] }),
  'bureau.contexts.list': (result: unknown) => {
    const answer = result as { contexts: Record<string, unknown>[] };
    const outcomes = [toolRunnerRefundedReply(4200), humanInputAnsweredReply('Staging')];
    return {
      ...answer,
      contexts: answer.contexts.map((context, index) => ({
        ...context,
        activity: 'idle',
        ...(outcomes[index] === undefined ? {} : { lastMessagePreview: outcomes[index] }),
      })),
    };
  },
};

const needsYou = (page: Page) => page.locator('[data-home-card="Needs you"]');

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

  // COR-2329 reverses row 01d (owner, 2026-11-13): one Spotlight and one quiet count, not four tiles.
  test('leads with one Spotlight, 2 need you, and one unframed count under it', async ({
    page,
  }) => {
    await openHome(page);
    const spotlight = page.getByTestId('home-spotlight');
    await expect(spotlight).toHaveText('2 need you');
    const counts = page.getByTestId('home-counts');
    await expect(counts.locator('.cinder-statistic')).toHaveText([/Failed in 24 hours\s*0/]);
    // The count draws no card: no border and no surface of its own.
    await expect(counts.locator('.cinder-statistic')).toHaveCSS('border-top-width', '0px');
    await expect(counts).toHaveCSS('border-top-width', '0px');
    // The Spotlight is the largest text on the page, and the count sits under it.
    const sizes = await page.evaluate(() => ({
      spotlight: parseFloat(
        getComputedStyle(document.querySelector('.cinder-spotlight__value')!).fontSize,
      ),
      count: parseFloat(
        getComputedStyle(document.querySelector('.cinder-statistic__value')!).fontSize,
      ),
    }));
    expect(sizes.spotlight).toBeGreaterThan(sizes.count);
    const spotlightBox = await spotlight.boundingBox();
    const countBox = await counts.boundingBox();
    expect(countBox!.y).toBeGreaterThan(spotlightBox!.y + spotlightBox!.height - 1);
  });

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
    await expect(card.getByRole('link', { name: 'Open Reviews' })).toHaveAttribute(
      'href',
      '/reviews',
    );
    // Needs you leads: it sits above Needs attention.
    const attention = page.getByRole('heading', { level: 2, name: 'Needs attention' });
    const waitingTop = await card
      .getByRole('heading', { level: 2, name: 'Needs you' })
      .boundingBox();
    const attentionTop = await attention.boundingBox();
    expect(waitingTop!.y).toBeLessThan(attentionTop!.y);
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
    await expect(card.locator('.cinder-select[data-cinder-variant="ghost"]').first()).toBeVisible();
    const send = card.getByRole('button', { name: 'Send' });
    await expect(send).toBeEnabled();
    await expect(send).toHaveAttribute('data-cinder-variant', 'primary');
    await expect(send.locator('svg')).toBeVisible();
    // It is a right column: its left edge is past both lists'.
    const start = await card.boundingBox();
    const waiting = await needsYou(page).boundingBox();
    expect(start!.x).toBeGreaterThan(waiting!.x + waiting!.width - 1);
    await captureForDesignReview(page, {
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
    await expect(rows.nth(0)).toContainText('Please refund order 4471, it arrived damaged.');
    // A chat that waits on an approval says what the agent said, and one that waits on a question
    // says the question.
    await expect(rows.nth(0)).toContainText(
      'I found order 4471 ($42.00). I need your approval to refund it.',
    );
    await expect(rows.nth(1)).toContainText('Which environment should the release go to?');
    await expect(rows.nth(0)).toContainText('10:42 AM');
    await expect(rows.nth(2)).toContainText('Done');
    await expect(rows.nth(2)).toContainText('Say hello');
    await expect(rows.nth(2)).toContainText('Yesterday, 4:12 PM');
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
          providers: [...(answer.providers ?? []), { name: 'anthropic', hasKey: true }].map(
            (provider) => ({ ...provider, hasKey: true }),
          ),
        },
      });
    });
  });

  test('reads zero everywhere, says nothing is waiting, and Send is live (01s, 01t, 01u, 01v)', async ({
    page,
    checkA11y,
  }) => {
    await openHome(page);
    await expect(page.getByTestId('home-spotlight')).toHaveText('Nothing needs you');
    const counts = page.getByTestId('home-counts');
    await expect(counts.locator('.cinder-statistic')).toHaveText([/Failed in 24 hours\s*0/]);
    await expect(counts.locator('[data-cinder-attention]')).toHaveCount(0);
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
    const empty = page.getByRole('group', { name: 'Nothing is waiting on you' });
    await expect(empty).toContainText('Approvals and questions from your agents show up here.');
    await expect(empty.getByRole('link', { name: 'Open Reviews' })).toBeVisible();
    const clear = page.getByTestId('attention-clear');
    await expect(clear.getByRole('group', { name: 'Nothing needs attention' })).toContainText(
      'Storage, schedules, providers and hooks are fine.',
    );
    await expect(clear.getByRole('link', { name: 'Open Health' })).toBeVisible();
    // The clear line sits under its own heading, so it never reads as part of the section above.
    const attentionSection = page.locator('[data-home-card="Needs attention"]');
    await expect(
      attentionSection.getByRole('heading', { level: 2, name: 'Needs attention' }),
    ).toBeVisible();
    await expect(attentionSection.getByTestId('attention-clear')).toHaveCount(1);
    await expect(attentionSection.getByRole('link', { name: 'Open Health' })).toHaveCount(1);
    const rows = page.getByRole('list', { name: 'Recent chats' }).getByRole('listitem');
    await expect(rows.nth(0)).toContainText('Done');
    await expect(rows.nth(0)).toContainText(
      'You approved it. Refunded $42.00 to the original payment method.',
    );
    await expect(rows.nth(1)).toContainText('You answered Staging.');
    await expect(rows.nth(2)).toContainText('Hello! How can I help?');
    await expect(
      page.getByTestId('home-start-chat').getByRole('button', { name: 'Send' }),
    ).toBeEnabled();
    await captureForDesignReview(page, { route: '/', state: 'nothing waiting', source: SOURCE });
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

  test('is the three-step checklist under a welcome line, with Recent chats empty (01y, 01z, 02a, 02b, 13c, 13d, 13f, 13g, 13h, 13j, 14c, 14d, 14e)', async ({
    page,
    checkA11y,
  }) => {
    await openFirstRun(page);
    await expect(page.getByTestId('home-date')).toHaveText(
      'Welcome. Three steps to your first chat.',
    );
    await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toHaveClass(
      /cinder-sr-only/,
    );
    await expect(page.getByRole('heading', { level: 2, name: 'Get started' })).toBeVisible();
    await expect(checklist(page)).toContainText('0 of 3 done');
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
    await expect(
      checklist(page).locator('.cinder-button[data-cinder-variant="primary"]'),
    ).toHaveText(['Connect a provider']);
    await expect(steps.nth(1).getByRole('button', { name: 'Use Assistant' })).toHaveAttribute(
      'data-cinder-variant',
      'ghost-accent',
    );
    await expect(steps.nth(1).getByRole('link', { name: 'Create an agent' })).toHaveAttribute(
      'data-cinder-variant',
      'secondary',
    );
    // Step 3 is live with steps 1 and 2 open, and opens New chat with Assistant.
    const start = steps.nth(2).getByRole('link', { name: 'Start a chat' });
    await expect(start).toHaveAttribute('data-cinder-variant', 'secondary');
    await expect(start).not.toHaveAttribute('aria-disabled', 'true');
    await expect(start).toHaveAttribute('href', /^\/chats\/new\?agent=[^&]*assistant$/);
    // The counts, Needs you, the composer and the provider row are not drawn, and no banner says it.
    await expect(page.getByTestId('home-counts')).toHaveCount(0);
    await expect(page.locator('[data-home-card="Needs you"]')).toHaveCount(0);
    await expect(page.getByTestId('home-start-chat')).toHaveCount(0);
    await expect(page.locator('[data-home-card="Needs attention"]')).toHaveCount(0);
    await expect(page.locator('main').getByRole('alert')).toHaveCount(0);
    await expect(page.getByText('Connect a model provider')).toHaveCount(0);
    // Below the checklist, Recent chats is a compact empty state with a chat disc.
    const recent = page.locator('[data-home-card="Recent chats"]');
    await expect(recent.getByRole('heading', { level: 3, name: 'No chats yet' })).toBeVisible();
    await expect(recent).toContainText('Your chats appear here once you send a first message.');
    await expect(recent.locator('.cinder-empty-state-icon svg')).toBeVisible();
    await expect(recent.getByRole('link', { name: 'All chats' })).toHaveCount(0);
    const checklistBox = await checklist(page).boundingBox();
    const recentBox = await recent.boundingBox();
    expect(checklistBox!.y + checklistBox!.height).toBeLessThan(recentBox!.y);
    expect(checklistBox!.width).toBeLessThan(recentBox!.width);
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
        json: { ...answer, providers: [{ name: 'anthropic', configured: true, hasKey: true }] },
      });
    });
    await openFirstRun(page);
    await expect(page.getByTestId('home-date')).toHaveText('Welcome. Two steps left.');
    await expect(checklist(page)).toContainText('1 of 3 done');
    await expect(stepsOf(page).nth(0)).toContainText('Anthropic is connected.');
    await expect(
      stepsOf(page).nth(1).getByRole('link', { name: 'Create an agent' }),
    ).toHaveAttribute('data-cinder-variant', 'primary');
    await stepsOf(page).nth(1).getByRole('button', { name: 'Use Assistant' }).click();
    await expect(page.getByTestId('home-date')).toHaveText('Welcome. One step left.');
    await expect(checklist(page)).toContainText('2 of 3 done');
    await expect(stepsOf(page).nth(1)).toContainText('Assistant is ready to use.');
    await expect(stepsOf(page).nth(2).getByRole('link', { name: 'Start a chat' })).toHaveAttribute(
      'data-cinder-variant',
      'primary',
    );
    // The box that starts a chat is back below the provider notice, with Assistant and a live Send.
    const composer = page.getByTestId('home-start-chat');
    await expect(composer.getByPlaceholder('Ask an agent to do something')).toBeVisible();
    await expect(composer.getByRole('combobox', { name: 'Agent' })).toContainText('Assistant');
    await expect(composer.getByRole('button', { name: 'Send' })).toBeEnabled();
    await expect(page.getByTestId('home-counts')).toHaveCount(0);
    await captureForDesignReview(page, {
      route: '/',
      state: 'first run, steps 1 and 2 done',
      source: SOURCE,
    });
    await checkA11y('Home after steps 1 and 2');
  });

  test('stacks the checklist over Recent chats on a phone', async ({ page }) => {
    await openFirstRun(page, 390);
    await expect(stepsOf(page)).toHaveCount(3);
    await captureForDesignReview(page, { route: '/', state: 'first run', source: SOURCE });
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
    // It sits under Needs you (which shows its empty state) and above Needs attention.
    const waiting = await needsYou(page).boundingBox();
    const running = await card.boundingBox();
    const attention = await page.getByTestId('attention-clear').boundingBox();
    expect(waiting!.y + waiting!.height).toBeLessThan(running!.y);
    expect(running!.y + running!.height).toBeLessThan(attention!.y);
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
  await page.route('**/bureau/jsonrpc', held);
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
    // The date line, the count's label and the section headings are real text.
    await expect(page.getByTestId('home-date')).toHaveText(
      'Monday, Nov 2. Times show in Central time (CST).',
    );
    const counts = page.getByTestId('home-loading-counts').locator('.cinder-statistic');
    await expect(counts.locator('.cinder-statistic__label')).toHaveText(['Failed in 24 hours']);
    // The Spotlight, the value, the rows and the composer are placeholders.
    await expect(
      page.getByTestId('home-loading-focus').locator('> .cinder-skeleton').first(),
    ).toBeVisible();
    await expect(counts.locator('.cinder-statistic__value .cinder-skeleton')).toHaveCount(1);
    await expect(counts.locator('.cinder-statistic__value')).toHaveText(['']);
    await expect(body.getByRole('heading', { level: 2 })).toHaveText([
      'Needs you',
      'Needs attention',
      'Start a chat',
      'Recent chats',
    ]);
    // The rows are Cinder's grouped placeholders, in the grouped lists' own shape.
    await expect(body.locator('.cinder-skeleton-group[data-cinder-variant="grouped"]')).toHaveCount(
      3,
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
    await captureForDesignReview(page, { route: '/', state: 'loading', source: SOURCE });
    // The page settles its paint on animation frames, which a stopped clock never delivers.
    await page.clock.resume();
    await checkA11y('Home loading');

    // The page, once it has its answers, is laid out as the placeholders were.
    const before = await page.locator('[data-home-card="Start a chat"]').boundingBox();
    release();
    await expect(page.getByTestId('home-counts')).toBeVisible();
    await expect(homeBody(page)).toHaveAttribute('data-mode', 'overview');
    await expect(homeBody(page)).not.toHaveAttribute('aria-busy', 'true');
    const after = await page.locator('[data-home-card="Start a chat"]').boundingBox();
    expect(Math.round(after!.x)).toBe(Math.round(before!.x));
    expect(Math.round(after!.width)).toBe(Math.round(before!.width));
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
    await page.clock.runFor(9_699);
    await expect(page.getByText('Still loading Home.')).toHaveCount(0);
    await page.clock.runFor(1);
    const status = page.locator('.cinder-skeleton-status');
    await expect(status).toContainText('Still loading Home. This is taking longer than usual.');
    await expect(status.getByRole('button', { name: 'Cancel' })).toHaveAttribute(
      'data-cinder-variant',
      'ghost',
    );
    // It is the skeleton's own line above the placeholders, in view, not a banner (COR-2329: under
    // them it was cut off at the bottom of the viewport).
    await expect(page.getByRole('region', { name: 'Connection problem' })).toHaveCount(0);
    const firstPlaceholder = await page.getByTestId('home-date').boundingBox();
    const line = await status.boundingBox();
    expect(line!.y + line!.height).toBeLessThanOrEqual(firstPlaceholder!.y);
    await expect(status).toBeInViewport();
    await captureForDesignReview(page, { route: '/', state: 'still loading', source: SOURCE });

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
    await page.route('**/bureau/jsonrpc', async (route) => {
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
    await expect(failure.getByRole('button', { name: 'Try again' })).toHaveAttribute(
      'data-cinder-variant',
      'secondary',
    );
    // One flat row inside the card: the card keeps its title, and has no link and no list.
    await expect(card.getByRole('heading', { level: 2, name: 'Needs attention' })).toBeVisible();
    await expect(card.getByRole('link')).toHaveCount(0);
    await expect(card.getByRole('listitem')).toHaveCount(0);
    // The Spotlight and the count have reads of their own and are unchanged.
    await expect(page.getByTestId('home-spotlight')).toHaveText('2 need you');
    await expect(page.getByTestId('home-counts').locator('.cinder-statistic')).toHaveText([
      /Failed in 24 hours\s*0/,
    ]);
    // Needs you, Start a chat and Recent chats render normally.
    await expect(needsYou(page).getByRole('listitem')).toHaveCount(2);
    await expect(page.getByTestId('home-start-chat').getByRole('textbox')).toBeVisible();
    await expect(
      page.getByRole('list', { name: 'Recent chats' }).getByRole('listitem'),
    ).toHaveCount(3);
    await captureForDesignReview(page, { route: '/', state: 'one card fails', source: SOURCE });
    await checkA11y('Home with one card failing');

    // Try again asks that card's read again.
    healed = true;
    await failure.getByRole('button', { name: 'Try again' }).click();
    await expect(card.getByRole('listitem')).toHaveCount(3);
    await expect(card.getByTestId('home-card-error')).toHaveCount(0);
  });
});

const HOST_REQUESTS = /\/(v1|bureau|api|host)\//;
const REFUSED = /net::ERR_CONNECTION_REFUSED/;
/** What Home reads, and the server's health probe: the shell itself (who the caller is) is not cut off. */
const HOME_READS = /\/(bureau\/jsonrpc|host\/providers|v1\/health)$/;

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
    await expect(page.getByTestId('home-counts')).toBeVisible();
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
    await expect(banner.getByRole('button', { name: 'Retry now' })).toBeVisible();
    // The banner sits under the top bar, above the page.
    const bannerBox = await banner.boundingBox();
    const topBar = await page.getByRole('banner').boundingBox();
    const date = await page.getByTestId('home-date').boundingBox();
    expect(bannerBox!.y).toBeGreaterThanOrEqual(topBar!.y + topBar!.height - 1);
    expect(bannerBox!.y + bannerBox!.height).toBeLessThanOrEqual(date!.y);

    // Old data keeps full contrast (never dimmed with opacity), and nothing is zeroed.
    await expect(page.getByTestId('home-spotlight')).toHaveText('2 need you');
    await expect(page.getByTestId('home-counts').locator('.cinder-statistic')).toHaveText([
      /Failed in 24 hours\s*0/,
    ]);
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
    expect(await opacity(page.getByRole('heading', { level: 2, name: 'Needs you' }))).toBe(1);
    expect(
      await opacity(needsYou(page).getByText('Which environment should the release go to?')),
    ).toBe(1);
    expect(await opacity(page.getByTestId('home-counts'))).toBe(1);
    expect(await opacity(page.getByTestId('home-spotlight'))).toBe(1);
    // Only the controls that change something are inert.
    const disabledColour = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--cinder-text-disabled)';
      document.body.append(probe);
      const colour = getComputedStyle(probe).color;
      probe.remove();
      return colour;
    });
    for (const [name, scope] of [
      ['Answer', needsYou(page)],
      ['Review', needsYou(page)],
      ['Review storage', page.locator('[data-home-card="Needs attention"]')],
      ['View schedule', page.locator('[data-home-card="Needs attention"]')],
      ['Connect a provider', page.locator('[data-home-card="Needs attention"]')],
    ] as const) {
      const control = scope.getByRole('link', { name, exact: true });
      await expect(control, `${name} is held`).toHaveAttribute('aria-disabled', 'true');
      // It reads as off by its colour, never by a fade: the disabled text colour at full opacity.
      expect(await opacity(control), `${name} is not faded`).toBe(1);
      expect(
        await control.evaluate((element) => getComputedStyle(element).color),
        `${name} reads as off`,
      ).toBe(disabledColour);
    }
    await expect(needsYou(page).getByRole('link', { name: 'Open Reviews' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    // The composer keeps what was typed; Assistant is still the agent, with the note beside it,
    // and Send is disabled.
    const composer = page.getByTestId('home-start-chat');
    await expect(message).toHaveValue('What did I approve yesterday?');
    await expect(composer.getByRole('combobox', { name: 'Agent' })).toContainText('Assistant');
    await expect(composer.getByText('Off until it’s back')).toBeVisible();
    await expect(composer.getByRole('button', { name: 'Send' })).toBeDisabled();
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
    await expect(page.getByTestId('home-counts')).toBeVisible();
    await expect(page.getByTestId('home-unreachable')).toHaveCount(0);
  });
});

test.describe('Home on a phone (05c, 05o, 05p, 05q)', () => {
  test.use({ hasTouch: true, isMobile: true });

  test('has a menu button, Home and three icon buttons, the Spotlight over one count, and 44px buttons at their own width under each review (05c, 05o, 05p, 05q)', async ({
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
    // The Spotlight, then one count under it with no dot while nothing failed.
    await expect(page.getByTestId('home-spotlight')).toHaveText('2 need you');
    const stats = page.getByTestId('home-counts').locator('.cinder-statistic');
    await expect(stats).toHaveText([/Failed in 24 hours\s*0/]);
    await expect(stats.locator('xpath=self::*[@data-cinder-attention]')).toHaveCount(0);
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

  test('stacks each step’s actions full width under its text on a first run (05c)', async ({
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
        if ((await button.getAttribute('data-cinder-variant')) === 'ghost-accent') continue;
        const box = await button.boundingBox();
        expect(
          box!.y,
          `step ${String(index + 1)}'s button is under its text`,
        ).toBeGreaterThanOrEqual(text!.y + text!.height - 1);
        expect(box!.width, `step ${String(index + 1)}'s button is full width`).toBeGreaterThan(
          step!.width - 80,
        );
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
  test('keeps the 76px rail, the full top bar, the Spotlight and the buttons trailing their rows', async ({
    page,
    checkA11y,
  }) => {
    await openHome(page, 768);
    const rail = page.locator('aside.weft-shell-sidebar');
    expect(Math.round((await rail.boundingBox())!.width)).toBe(76);
    await expect(
      page.getByRole('banner').getByRole('button', { name: /^Search everything/ }),
    ).toContainText('⌘K');
    await expect(
      page.getByRole('navigation', { name: 'Views' }).getByRole('link', { name: /^Reviews/ }),
    ).toContainText('2');
    await expect(page.getByTestId('home-spotlight')).toHaveText('2 need you');
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
