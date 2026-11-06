/**
 * Home (`/`) on the sample world (`fixtures/sample-world-seed.ts`, the showcase host) at the
 * browser's sample clock, Monday, Nov 2, 10:46 AM Central time: the overview of what needs you and
 * what needs attention (COR-2016, design rows 01a to 01k, 01s to 01v). The date line, the four
 * counts, the two reviews waiting on the person, the three system problems, the box that starts a
 * chat and the chats last in are each read as the design words them.
 *
 * Two captioned states the sample world does not hold are made by answering the Bureau's own
 * operations with what a different world would answer (`answerBureau`), so the screen is the one
 * the real application draws, and each is captured for the design review under its own name: a
 * host with no storage rule (Needs attention has two rows), and a person with nothing to review
 * (every count reads zero, and the cards read as caught up).
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
  changes: Readonly<Record<string, (result: unknown) => unknown>>,
): Promise<void> {
  await page.route('**/bureau/jsonrpc', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as {
      id?: unknown;
      method?: string;
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
      json: { ...answer, result: change(answer.result) },
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
  });

  test('lists the chats last in, with a status word, the latest message and the time (01l)', async ({
    page,
  }) => {
    await openHome(page);
    const rows = page.getByRole('list', { name: 'Recent chats' }).getByRole('listitem');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('Waiting on you');
    await expect(rows.nth(0)).toContainText('Please refund order 4471, it arrived damaged.');
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
