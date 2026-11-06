/**
 * Home (`/`) on the sample world (`fixtures/sample-world-seed.ts`, the showcase host) at the
 * browser's sample clock, Monday, Nov 2, 10:46 AM Central time: the overview of what needs you and
 * what needs attention (COR-2016, design rows 01a to 01k, 01s to 01v). The date line, the four
 * counts, the two reviews waiting on the person, the three system problems, the box that starts a
 * chat and the chats last in are each read as the design words them.
 *
 * Captioned states the sample world does not hold are made by answering the Bureau's own
 * operations with what a different world would answer (`answerBureau`), so the screen is the one
 * the real application draws, and each is captured for the design review under its own name: a
 * host with no storage rule (Needs attention has two rows), a person with nothing to review (every
 * count reads zero, and the cards read as caught up), a run going (rows 01w and 01x), and a new
 * installation that lists Assistant, the first-run checklist (rows 01y to 02b, 13c to 13j, 14c to
 * 14j). The fresh installation's own host lists no Assistant, so `first-run.spec.ts` reads the
 * checklist there as it completes and without one.
 */
import type { Page } from '@playwright/test';

import { SAMPLE_NOW, SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_JOURNEY_URL, E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

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
    const response = await route.fetch();
    const answer = (await response.json()) as { result?: unknown };
    await route.fulfill({
      response,
      json: { ...answer, result: change(answer.result, body.params ?? {}) },
    });
  });
}

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
      'Monday, Nov 2 · Times show in Central time (CST)',
    );
  });

  test('says four counts in one row, as Health does: 0, 2, 0 and 4 (01d)', async ({ page }) => {
    await openHome(page);
    const counts = page.getByTestId('home-counts');
    await expect(counts.locator('.cinder-statistic')).toHaveText([
      /Running now\s*0/,
      /Needs you\s*2/,
      /Failed in 24 hours\s*0/,
      /Missed schedule runs \(7 days\)\s*4/,
    ]);
    const boxes = await counts.locator('.cinder-statistic').evaluateAll((elements) =>
      elements.map((element) => {
        const { top } = element.getBoundingClientRect();
        return Math.round(top);
      }),
    );
    expect(new Set(boxes).size, 'the four counts share one row').toBe(1);
  });

  test('lists the two reviews waiting on you, oldest first, kind first on line two (01f, 01g)', async ({
    page,
  }) => {
    await openHome(page);
    const card = needsYou(page);
    const rows = card.getByRole('listitem');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Which environment should the release go to?');
    await expect(rows.nth(0)).toContainText('Question · Request human input · 1 h ago');
    await expect(rows.nth(0).getByRole('link', { name: 'Answer' })).toBeVisible();
    await expect(rows.nth(1)).toContainText('Refund order 4471 for $42.00?');
    await expect(rows.nth(1)).toContainText('Approval · Tool runner · Can’t be undone · 4 min ago');
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
      'Schedule · Assistant · Every day at 3:00 AM (9:00 AM UTC)',
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
    // A chat that waits on you says the question it asks.
    await expect(rows.nth(0)).toContainText('Refund order 4471 for $42.00?');
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
    await answerBureau(page, {
      'bureau.reviews.list': (result) => ({ ...(result as object), reviews: [] }),
      'bureau.health.attention': () => ({ items: [], count: 0, checks: [] }),
      'bureau.contexts.list': (result) => {
        const answer = result as { contexts: Record<string, unknown>[] };
        const outcomes = [
          'You approved it. Refunded $42.00 to the original payment method.',
          'You answered Staging.',
        ];
        return {
          ...answer,
          contexts: answer.contexts.map((context, index) => ({
            ...context,
            activity: 'idle',
            ...(outcomes[index] === undefined ? {} : { lastMessagePreview: outcomes[index] }),
          })),
        };
      },
    });
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
    const counts = page.getByTestId('home-counts');
    await expect(counts.locator('.cinder-statistic')).toHaveText([
      /Running now\s*0/,
      /Needs you\s*0/,
      /Failed in 24 hours\s*0/,
      /Missed schedule runs \(7 days\)\s*0/,
    ]);
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
    await expect(clear).toContainText(
      'Nothing needs attention · Storage, schedules, providers and hooks are fine.',
    );
    await expect(clear.getByRole('link', { name: 'Open Health' })).toBeVisible();
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
  test('counts 1 with no dot and lists the run under Needs you (01w, 01x)', async ({
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
      'bureau.reviews.list': (result) => ({ ...(result as object), reviews: [] }),
      'bureau.health.attention': () => ({ items: [], count: 0, checks: [] }),
    });
    await openHome(page);
    await expect(page.getByTestId('home-counts').locator('.cinder-statistic').first()).toHaveText(
      /Running now\s*1/,
    );
    await expect(
      page.getByTestId('home-counts').locator('.cinder-statistic').first(),
    ).not.toHaveAttribute('data-cinder-attention', '');
    const card = page.locator('[data-home-card="Running now"]');
    await expect(card.getByRole('heading', { level: 2, name: 'Running now' })).toBeVisible();
    const row = card.getByRole('listitem');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('Daily summary');
    await expect(row).toContainText('Running · Schedule · Assistant · started 10:44 AM');
    await expect(row.locator('.cinder-status-dot')).toHaveAttribute('data-cinder-status', 'info');
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
    await captureForDesignReview(page, { route: '/', state: 'running now', source: SOURCE });
    await checkA11y('Home with a run going');
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
