/**
 * The chat list (`/chats`) on the sample world (`fixtures/sample-world-seed.ts`, the showcase host)
 * at the browser's sample clock, Monday, Nov 2, 10:46 AM Central time (COR-2016, design rows 16c,
 * 16f, 16g, 17u to 17x, 11g, 11h, 06l): the pane's header, the chats under their day bands,
 * and each state of the list (first use, no results, loading, failing). A state the sample world
 * does not hold is made by answering the Bureau's own operation with what a different world would
 * answer, and each is captured for the design review under its own name.
 */
import type { Page, Route } from '@playwright/test';

import {
  SAMPLE_NOW,
  SAMPLE_NOW_MILLISECONDS,
  SAMPLE_TIME_ZONE,
} from '../../fixtures/sample-now.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, loggedFailedResponse, test } from './fixtures.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'chat-list.spec.ts';

/**
 * The chats the sample world holds: the refund, the release question, Say hello, Look up order
 * 4468 (the chat behind Runs' Friday row) and Rename the billing tables. The boards' chat list
 * draws four of them.
 */
const CHAT_COUNT = 5;

/** Where ListDetail remembers the divider (`storageKey` of the chat list). */
const DIVIDER_KEY = 'interborough-chats';

/** Opens the chat list at `width` and waits until the chats are listed. */
async function openChats(page: Page, width = 1280, path = '/chats'): Promise<void> {
  await page.clock.setFixedTime(SAMPLE_NOW);
  await page.setViewportSize({ width, height: 900 });
  await page.goto(path);
  await expect(page.locator('[data-chat]')).toHaveCount(CHAT_COUNT);
}

/** Answers the Bureau operation `method` with `answer`, and leaves every other operation to the host. */
async function answerOperation(
  page: Page,
  method: string,
  answer: (route: Route, id: unknown) => Promise<void> | void,
): Promise<void> {
  await page.route('**/bureau/jsonrpc', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as {
      method?: string;
      id?: unknown;
    };
    if (body.method === method) {
      await answer(route, body.id);
      return;
    }
    await route.fallback();
  });
}

const list = (page: Page) => page.getByRole('region', { name: 'Chats' });
const row = (page: Page, title: string) => page.locator('[data-chat]').filter({ hasText: title });

test.describe('the chat list on the sample world', () => {
  test('is "Chats" with a secondary "+" and a Search chats field below it (16c)', async ({
    page,
  }) => {
    await openChats(page);
    const header = list(page).locator('header');
    await expect(header.getByRole('heading', { level: 1, name: 'Chats' })).toBeVisible();
    const plus = header.getByRole('link', { name: 'New chat' });
    await expect(plus).toHaveAttribute('data-cinder-variant', 'secondary');
    await expect(plus).toHaveAttribute('href', '/chats/new');
    await plus.hover();
    await expect(page.getByRole('tooltip').filter({ hasText: 'New chat' })).toBeVisible();
    const field = header.getByRole('searchbox', { name: 'Search chats' });
    const plusBox = await plus.boundingBox();
    const fieldBox = await field.boundingBox();
    expect(fieldBox!.y, 'the field sits under the title row').toBeGreaterThan(
      plusBox!.y + plusBox!.height,
    );
  });

  test('lists the chats under their days, each band naming Central time (16f, 16g, 11g)', async ({
    page,
  }) => {
    await openChats(page);
    const bands = list(page).locator('.cinder-data-list-group__header');
    await expect(bands).toHaveText([
      /^Today\s*Central time$/,
      /^Yesterday, Sunday, Nov 1\s*Central time$/,
      /^Friday, Oct 30\s*Central time$/,
      /^Thursday, Oct 29\s*Central time$/,
    ]);
    const refund = row(page, 'Please refund order 4471, it arrived damaged.');
    await expect(refund).toContainText('10:42 AM');
    await expect(refund).toContainText('Waiting on you');
    // Line two is the agent's own last words, which is what it needs from you (16f); a chat that
    // waits on a question says the question instead.
    await expect(refund).toContainText(
      'I found order 4471 ($42.00). I need your approval to refund it.',
    );
    const release = row(page, 'Ship the release notes fix.');
    await expect(release).toContainText('9:46 AM');
    await expect(release).toContainText('Waiting on you');
    await expect(release).toContainText('Which environment should the release go to?');
    const hello = row(page, 'Say hello');
    await expect(hello).toContainText('4:12 PM');
    await expect(hello).toContainText('Done');
    await expect(hello).toContainText('Hello! How can I help?');
    const billing = row(page, 'Rename the billing tables');
    await expect(billing).toContainText('11:05 AM');
    await expect(billing).toContainText('Ended');
    await expect(billing).toContainText('The server restarted before I finished.');
    await expect(row(page, 'Look up order 4468')).toContainText('Done');
    // The rows are in order: the day bands newest first, and each day newest first.
    await expect(page.locator('[data-chat] a').first()).toContainText('Please refund order 4471');
    await captureForDesignReview(page, { route: '/chats', state: 'ready', source: SOURCE });
  });

  test('has the status segments All 5, Waiting on you 2 and Done 2, and Ended is under All only (11g)', async ({
    page,
  }) => {
    await openChats(page);
    const segments = list(page).getByRole('radiogroup', { name: 'Status' });
    await expect(segments.getByRole('radio')).toHaveText([
      /^\s*All\s*,?\s*5\s*$/,
      /^\s*Waiting on you\s*,?\s*2\s*$/,
      /^\s*Done\s*,?\s*2\s*$/,
    ]);
    await segments.locator('[data-cinder-segment-value="waiting"]').click();
    await expect(page.locator('[data-chat]')).toHaveCount(2);
    await segments.locator('[data-cinder-segment-value="done"]').click();
    await expect(page.locator('[data-chat]')).toHaveCount(2);
    await expect(row(page, 'Rename the billing tables')).toHaveCount(0);
    await segments.locator('[data-cinder-segment-value="all"]').click();
    await expect(page.locator('[data-chat]')).toHaveCount(CHAT_COUNT);
  });

  test('puts status and message on line two in one fixed column, so the messages line up (frame a)', async ({
    page,
  }) => {
    await openChats(page);
    const left = async (title: string) => {
      const meta = row(page, title).locator('.cinder-stacked-list-item__meta');
      const box = await meta.boundingBox();
      return Math.round(box!.x);
    };
    // The meta of each row starts under its title, and the status column ahead of it is one width.
    const waiting = await left('Please refund order 4471, it arrived damaged.');
    expect(await left('Say hello')).toBe(waiting);
    expect(await left('Rename the billing tables')).toBe(waiting);
  });

  test('marks the open chat and opens a row in place when it is chosen', async ({ page }) => {
    await openChats(page);
    await row(page, 'Say hello').getByRole('link').click();
    await expect(page).toHaveURL(/\/chats\/[^/]+$/);
    await expect(row(page, 'Say hello').getByRole('link')).toHaveAttribute('aria-current', 'true');
    await expect(page.getByRole('region', { name: 'Open chat' })).toContainText('Say hello');
  });

  test('keeps the open chat open when a search leaves it out of the list', async ({ page }) => {
    await openChats(page);
    await row(page, 'Say hello').getByRole('link').click();
    await expect(page.getByRole('region', { name: 'Open chat' })).toContainText('Say hello');
    await list(page).getByRole('searchbox', { name: 'Search chats' }).fill('refund');
    await expect(page.locator('[data-chat]')).toHaveCount(1);
    await expect(page.getByRole('region', { name: 'Open chat' })).toContainText('Say hello');
  });
});

test.describe('the chat list hidden beside an open chat (COR-2327 AC1)', () => {
  test('hides with Hide chats, leaves Show chats on a rail, and stays hidden across a reload', async ({
    page,
    checkA11y,
  }) => {
    const refund = 'Please refund order 4471, it arrived damaged.';
    await openChats(page);
    await row(page, refund).getByRole('link').first().click();
    const detail = page.getByRole('region', { name: 'Open chat' });
    await expect(detail.getByRole('heading', { level: 1, name: refund })).toBeVisible();
    const detailBefore = await detail.boundingBox();

    const hide = list(page).locator('header').getByRole('button', { name: 'Hide chats' });
    await expect(hide).toBeVisible();
    await hide.click();

    // The list is gone, not squeezed: nothing of it is on the page, and the chat takes its width.
    await expect(list(page)).toHaveCount(0);
    const show = page.getByRole('button', { name: 'Show chats' });
    await expect(show).toBeFocused();
    const detailAfter = await detail.boundingBox();
    expect(detailAfter!.width).toBeGreaterThan(detailBefore!.width + 150);
    await checkA11y('the chat list hidden beside an open chat');
    await captureForDesignReview(page, {
      route: '/chats/:chat',
      state: 'chat list hidden',
      source: SOURCE,
    });

    // The choice is kept: a reload opens the chat with the list still hidden.
    await page.reload();
    await expect(detail.getByRole('heading', { level: 1, name: refund })).toBeVisible();
    await expect(list(page)).toHaveCount(0);

    await page.getByRole('button', { name: 'Show chats' }).click();
    await expect(page.locator('[data-chat]')).toHaveCount(CHAT_COUNT);
    await expect(list(page).getByRole('button', { name: 'Hide chats' })).toBeFocused();
  });
});

test.describe('one left edge for the open chat (COR-2327 B4)', () => {
  const refund = 'Please refund order 4471, it arrived damaged.';

  /**
   * The left edges of the title, the runs line and each alert when drawn, the transcript's content
   * and the composer's, read in one pass so a scroll or a late layout cannot fall between them.
   */
  const leftEdges = (page: Page) =>
    page.evaluate(() => {
      const region = document.querySelector('[aria-label="Open chat"]') ?? document;
      const left = (element: Element | null, inner = false): number | null => {
        if (element === null) return null;
        const box = element.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) return null;
        return inner
          ? box.left + Number.parseFloat(getComputedStyle(element).paddingLeft)
          : box.left;
      };
      const edges: Record<string, number | null> = {
        title: left(region.querySelector('h1.cinder-page-header__title')),
        runs: left(region.querySelector('.weft-chat-strip')),
        transcript: left(region.querySelector('.chat-timeline'), true),
        composer: left(region.querySelector('.chat-input-area'), true),
      };
      region
        .querySelectorAll('.weft-chat-head > .cinder-alert, .weft-chat-head > [role="alert"]')
        .forEach((alert, index) => (edges[`alert ${index}`] = left(alert)));
      return edges;
    });

  async function expectOneEdge(page: Page, label: string): Promise<void> {
    await expect(
      page
        .getByRole('region', { name: 'Open chat' })
        .getByRole('heading', { level: 1, name: refund }),
    ).toBeVisible();
    await expect(page.locator('.chat-timeline').first()).toBeVisible();
    const edges = await leftEdges(page);
    const drawn = Object.entries(edges).filter(
      (entry): entry is [string, number] => entry[1] !== null,
    );
    expect(
      drawn.map(([name]) => name),
      label,
    ).toEqual(expect.arrayContaining(['title', 'transcript', 'composer']));
    const title = drawn.find(([name]) => name === 'title')![1];
    for (const [name, edge] of drawn) {
      expect(
        Math.abs(edge - title),
        `${label}: ${name} at ${edge}, title at ${title}`,
      ).toBeLessThanOrEqual(1);
    }
  }

  test('the title, runs line, alerts, transcript and composer share one left edge at 375, 768 and 1280, with the list shown and hidden', async ({
    page,
  }) => {
    for (const width of [768, 1280]) {
      await openChats(page, width);
      await row(page, refund).getByRole('link').first().click();
      await expectOneEdge(page, `${width}, list shown`);
      await list(page).locator('header').getByRole('button', { name: 'Hide chats' }).click();
      await expect(list(page)).toHaveCount(0);
      await expectOneEdge(page, `${width}, list hidden`);
      await page.getByRole('button', { name: 'Show chats' }).click();
      await expect(page.locator('[data-chat]')).toHaveCount(CHAT_COUNT);
    }
    // A phone shows the chat as a screen of its own.
    await openChats(page, 375);
    await row(page, refund).getByRole('link').first().click();
    await expectOneEdge(page, '375');
  });
});

test.describe('the chat list at other widths', () => {
  test('in a pane dragged wide names today’s date, and the agent before each message (11g, 11h)', async ({
    page,
  }) => {
    await page.addInitScript((key) => window.localStorage.setItem(key, '560'), DIVIDER_KEY);
    await openChats(page);
    await expect(list(page).locator('.cinder-data-list-group__header').first()).toHaveText(
      /^Today, Monday, Nov 2\s*Central time$/,
    );
    await expect(row(page, 'Please refund order 4471, it arrived damaged.')).toContainText(
      'Tool runner, I found order 4471 ($42.00). I need your approval to refund it.',
    );
    await expect(row(page, 'Ship the release notes fix.')).toContainText(
      'Request human input, Which environment should the release go to?',
    );
    await expect(row(page, 'Say hello')).toContainText('Assistant, Hello! How can I help?');
    await captureForDesignReview(page, {
      route: '/chats',
      state: 'wide pane',
      source: SOURCE,
    });
  });

  test('on a phone is its own screen: "Chat", the "+", day bands and rows, with no search (06l)', async ({
    page,
  }) => {
    await openChats(page, 375);
    const header = list(page).locator('header');
    await expect(header.getByRole('heading', { level: 1, name: 'Chat' })).toBeVisible();
    await expect(header.getByRole('link', { name: 'New chat' })).toHaveAttribute(
      'data-cinder-variant',
      'secondary',
    );
    await expect(header.getByRole('searchbox')).toHaveCount(0);
    await expect(list(page).locator('.cinder-data-list-group__header')).toHaveText([
      /^Today\s*Central time$/,
      /^Yesterday\s*Central time$/,
      /^Friday, Oct 30\s*Central time$/,
      /^Thursday, Oct 29\s*Central time$/,
    ]);
    const scrolls = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(scrolls, 'the page never scrolls sideways').toBe(false);
    await captureForDesignReview(page, { route: '/chats', state: 'ready', source: SOURCE });
  });

  test('on a tablet sits beside the open chat', async ({ page }) => {
    await openChats(page, 768);
    await row(page, 'Please refund order 4471, it arrived damaged.').getByRole('link').click();
    await expect(page.getByRole('region', { name: 'Open chat' })).toBeVisible();
    await expect(list(page)).toBeVisible();
    await captureForDesignReview(page, {
      route: '/chats/:chat',
      state: 'list beside the chat',
      source: SOURCE,
    });
  });
});

test.describe('the states of the chat list', () => {
  test('first use is "No chats yet" with the only primary New chat, and the "+" stays secondary (17u)', async ({
    page,
  }) => {
    // Nothing is waiting on anyone either: a chat a pending review names is listed on its own.
    await answerOperation(page, 'bureau.reviews.list', (route, id) =>
      route.fulfill({ json: { jsonrpc: '2.0', id, result: { reviews: [] } } }),
    );
    await answerOperation(page, 'bureau.contexts.list', (route, id) =>
      route.fulfill({
        json: { jsonrpc: '2.0', id, result: { contexts: [], nextOffset: null } },
      }),
    );
    await page.clock.setFixedTime(SAMPLE_NOW);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/chats');
    const state = list(page).locator('.cinder-empty-state');
    await expect(state.getByRole('heading', { level: 3, name: 'No chats yet' })).toBeVisible();
    await expect(state).toContainText('Start one with an agent.');
    await expect(state.getByRole('link', { name: 'New chat' })).toHaveAttribute(
      'data-cinder-variant',
      'primary',
    );
    await expect(page.locator('main [data-cinder-variant="primary"]')).toHaveCount(1);
    await expect(
      list(page).locator('header').getByRole('link', { name: 'New chat' }),
    ).toHaveAttribute('data-cinder-variant', 'secondary');
    await captureForDesignReview(page, { route: '/chats', state: 'first use', source: SOURCE });
  });

  test('a search with no results says what was searched and offers Clear search (17v)', async ({
    page,
  }) => {
    await openChats(page);
    await list(page).getByRole('searchbox', { name: 'Search chats' }).fill('parcelly');
    const state = list(page).locator('.cinder-empty-state');
    await expect(
      state.getByRole('heading', { level: 3, name: 'No chats match “parcelly”' }),
    ).toBeVisible();
    await expect(state).toContainText('Check the spelling or try another word.');
    await captureForDesignReview(page, { route: '/chats', state: 'no results', source: SOURCE });
    await state.getByRole('button', { name: 'Clear search' }).click();
    await expect(page.locator('[data-chat]')).toHaveCount(CHAT_COUNT);
  });

  test('loading is skeleton rows under the live header and "+", after 300 ms (17w)', async ({
    page,
  }) => {
    await page.clock.install({ time: SAMPLE_NOW_MILLISECONDS - 1_000 });
    await page.clock.pauseAt(SAMPLE_NOW);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await answerOperation(page, 'bureau.contexts.list', async (route) => {
      await gate;
      await route.fallback().catch(() => undefined);
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/chats');
    const pane = list(page);
    await expect(pane.getByRole('heading', { level: 1, name: 'Chats' })).toBeVisible();
    await expect(pane.getByRole('link', { name: 'New chat' })).toBeVisible();
    await expect(pane.locator('.cinder-skeleton-list')).toHaveCount(0);
    await page.clock.runFor(300);
    await expect(pane.locator('.cinder-skeleton-list')).toBeVisible();
    await expect(pane.locator('[data-chat]')).toHaveCount(0);
    await captureForDesignReview(page, { route: '/chats', state: 'loading', source: SOURCE });
    await page.clock.resume();
    release();
    await expect(page.locator('[data-chat]')).toHaveCount(CHAT_COUNT);
  });

  test('failing keeps the error in the list, and the rest of the page live (17x)', async ({
    page,
    pageErrors,
  }) => {
    // The test answers the list's read with a 500, and Chromium logs each such response.
    pageErrors.expectEvery({
      pattern: loggedFailedResponse(500, /\/bureau\/jsonrpc/),
      reason: 'the test answers the chat list with a 500',
    });
    await answerOperation(page, 'bureau.contexts.list', (route) =>
      route.fulfill({ status: 500, json: { error: 'No.' } }),
    );
    await page.clock.setFixedTime(SAMPLE_NOW);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/chats');
    const state = list(page).locator('.cinder-error-state');
    await expect(
      state.getByRole('heading', { level: 3, name: 'Couldn’t load chats' }),
    ).toBeVisible();
    await expect(state).toContainText('Interborough didn’t send them back.');
    await expect(state.getByRole('button', { name: 'Try again' })).toHaveAttribute(
      'data-cinder-variant',
      'secondary',
    );
    // The rest of the page is live: the shell, the header, and the pane beside the list.
    await expect(page.getByRole('navigation', { name: 'Views' })).toBeVisible();
    await expect(list(page).getByRole('searchbox', { name: 'Search chats' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Open chat' })).toBeVisible();
    await captureForDesignReview(page, { route: '/chats', state: 'failing', source: SOURCE });
  });
});
