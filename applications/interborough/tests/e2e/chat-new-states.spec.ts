/**
 * New chat's states on the sample world (`fixtures/sample-world-seed.ts`, the showcase host) at the
 * browser's sample clock, Monday, Nov 2, 10:46 AM Central time (COR-2016, design rows 24c, 24o, 24p,
 * 24q, 24r, 24s and 24v of PageNewChat): the page while the agents it starts with are read, when they
 * cannot be read, when there are none, when the first message cannot be sent, and at 375 pixels.
 * "Provider connected" is a captioned state outside the sample world, made by answering the host's
 * provider list as it would with a key in place; the others are the Bureau's own operations answered
 * as a different host would. Each frame is captured for the design review under its own name.
 */
import type { Locator, Page, Route } from '@playwright/test';

import {
  SAMPLE_NOW,
  SAMPLE_NOW_MILLISECONDS,
  SAMPLE_TIME_ZONE,
} from '../../fixtures/sample-now.ts';
import { connectProviderWithModels } from './chat-states-support.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'chat-new-states.spec.ts';
const REFUND_ASK = 'Please refund order 4471, it arrived damaged.';
const HOST_REQUESTS = /\/(v1|bureau|api|host)\//;
const REFUSED = /net::ERR_CONNECTION_(REFUSED|FAILED)|net::ERR_FAILED|Failed to load resource/;

const trail = (page: Page) => page.getByRole('navigation', { name: 'Breadcrumb' });
const welcome = (page: Page) => page.getByTestId('new-chat-welcome');
const field = (page: Page) => page.getByRole('textbox', { name: 'Message' });
const send = (page: Page) => page.locator('button[data-chat-send]');
const failure = (page: Page) => page.getByTestId('new-chat-failure');
const loading = (page: Page) => page.getByTestId('new-chat-loading');

/** The box of `locator`, which must be on the page. */
async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box, 'the element is on the page').not.toBeNull();
  return box!;
}

/** Whether the page scrolls sideways. */
const scrollsSideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);

/** The shell the page follows: Chat active, the breadcrumb "Chat › New chat", and the top bar. */
async function expectShell(page: Page): Promise<void> {
  await expect(trail(page).getByRole('link', { name: 'Chat' })).toBeVisible();
  await expect(trail(page).locator('[aria-current="page"]')).toHaveText('New chat');
  await expect(
    page
      .getByRole('navigation', { name: 'Views' })
      .getByRole('link', { name: 'Chat', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  const banner = page.getByRole('banner');
  await expect(banner.getByRole('button', { name: /^Search everything/ })).toContainText('⌘');
  await expect(banner.getByRole('button', { name: /^Notifications/ })).toBeVisible();
  await expect(banner.getByRole('button', { name: 'Quick settings' })).toBeVisible();
}

/**
 * Pins the page to the sample world's clock and stops it, so a timer fires only when the test runs
 * the clock (`page.clock.runFor`): the loading page's 300 ms and 10 s are then exact.
 */
async function pausedClock(page: Page): Promise<void> {
  await page.clock.install({ time: SAMPLE_NOW_MILLISECONDS - 1_000 });
  await page.clock.pauseAt(SAMPLE_NOW);
}

/** The agents' reads: the Bureau's list of agents, and the host's list of plugins that says which can run. */
const AGENT_READS = /\/(bureau\/jsonrpc|host\/plugins)$/;

/** Holds the agents' reads until the returned function is called. */
async function holdAgentReads(page: Page): Promise<() => void> {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(AGENT_READS, async (route: Route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { method?: string };
    if (route.request().method() === 'POST' && body.method !== 'bureau.agents.list') {
      await route.fallback();
      return;
    }
    await gate;
    await route.fallback().catch(() => undefined);
  });
  return release;
}

/** Answers the Bureau's list of agents with `answer`, a status, or nothing at all. */
async function answerAgents(
  page: Page,
  answer: { readonly agents: unknown[] } | { readonly status: number },
): Promise<void> {
  await page.route('**/bureau/jsonrpc', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as {
      method?: string;
      id?: unknown;
    };
    if (body.method !== 'bureau.agents.list') {
      await route.fallback();
      return;
    }
    if ('status' in answer) {
      await route.fulfill({ status: answer.status, body: 'down' });
      return;
    }
    await route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result: answer } });
  });
}

test.describe('New chat while its agents load (24o)', () => {
  test('draws nothing for 300 ms, then placeholders with the composer already there; after 10 s a status line offers Cancel', async ({
    page,
    checkA11y,
  }) => {
    await pausedClock(page);
    const release = await holdAgentReads(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/chats/new');
    // The shell is unchanged, and the page draws nothing in its main area yet.
    await expectShell(page);
    await expect(loading(page)).toBeAttached();
    await expect(page.locator('.cinder-skeleton').first()).toHaveCount(0);
    await page.clock.runFor(299);
    await expect(page.locator('.cinder-skeleton').first()).toHaveCount(0);
    await page.clock.runFor(1);
    // Placeholders stand where the agent's avatar, greeting and sentence will be: no real text yet.
    await expect(loading(page).locator('.cinder-skeleton').first()).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(0);
    // The composer is already there, with its placeholder "Message…" and a Send that cannot be
    // pressed, and a placeholder where each control will be.
    const composer = loading(page).getByRole('textbox');
    await expect(composer).toHaveAttribute('placeholder', 'Message…');
    await expect(composer).toBeDisabled();
    await expect(loading(page).locator('button[data-chat-send]')).toBeDisabled();
    await expect(loading(page).locator('button[data-chat-send]')).toContainText('Send');
    expect(
      await loading(page).locator('.ib-new-chat-loading__controls .cinder-skeleton').count(),
    ).toBeGreaterThanOrEqual(2);
    await captureForDesignReview(page, { route: '/chats/new', state: 'loading', source: SOURCE });

    // After 10 s the skeleton's own line says it is slow, with a ghost Cancel; it is not a banner.
    await page.clock.runFor(9_700);
    const status = page.locator('.cinder-skeleton-status');
    await expect(status).toContainText('Still loading agents. This is taking longer than usual.');
    await expect(status.getByRole('button', { name: 'Cancel' })).toHaveAttribute(
      'data-cinder-variant',
      'ghost',
    );
    await expect(page.getByRole('region', { name: 'Connection problem' })).toHaveCount(0);
    await captureForDesignReview(page, {
      route: '/chats/new',
      state: 'still loading',
      source: SOURCE,
    });

    // The page settles its paint on animation frames, which a stopped clock never delivers.
    await page.clock.resume();
    await checkA11y('New chat loading');
    release();
    await expect(welcome(page)).toBeVisible();
    await expect(field(page)).toBeEnabled();
  });

  test('Cancel returns to the chat list', async ({ page }) => {
    await pausedClock(page);
    await holdAgentReads(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/chats/new');
    await expect(loading(page)).toBeAttached();
    await page.clock.runFor(300);
    await expect(loading(page).locator('.cinder-skeleton').first()).toBeVisible();
    await page.clock.runFor(9_700);
    await page.locator('.cinder-skeleton-status').getByRole('button', { name: 'Cancel' }).click();
    await expect(page).toHaveURL(/\/chats$/);
  });
});

test.describe('New chat when the agents cannot be loaded (24p)', () => {
  test('replaces the greeting and the composer with the error, and Try again reads them again', async ({
    page,
    checkA11y,
    pageErrors,
  }) => {
    pageErrors.expectEvery({
      pattern: REFUSED,
      reason: 'the test answers the list of agents with a failure on purpose',
    });
    await answerAgents(page, { status: 500 });
    await page.clock.setFixedTime(SAMPLE_NOW);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/chats/new');

    await expectShell(page);
    const title = page.getByRole('heading', { level: 1, name: 'Agents couldn’t be loaded' });
    await expect(title).toBeVisible();
    await expect(
      page.getByText('Check that Interborough is running, then try again.'),
    ).toBeVisible();
    // The one primary is Try again; there is nothing to send to, so no composer is drawn.
    const retry = page.getByRole('button', { name: 'Try again' });
    await expect(retry).toHaveAttribute('data-cinder-variant', 'primary');
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await expect(page.locator('button[data-chat-send]')).toHaveCount(0);
    await expect(welcome(page)).toHaveCount(0);
    await captureForDesignReview(page, { route: '/chats/new', state: 'error', source: SOURCE });
    await checkA11y('New chat when the agents cannot be loaded');

    await page.unroute('**/bureau/jsonrpc');
    await retry.click();
    await expect(welcome(page)).toBeVisible();
    await expect(field(page)).toBeEnabled();
  });
});

test.describe('New chat with no agents (24q)', () => {
  test('shows the Agents first-use state, with New agent and Browse agents, and no composer', async ({
    page,
    checkA11y,
  }) => {
    await answerAgents(page, { agents: [] });
    await page.clock.setFixedTime(SAMPLE_NOW);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/chats/new');

    await expectShell(page);
    await expect(page.getByRole('heading', { level: 1, name: 'No agents yet' })).toBeVisible();
    await expect(
      page.getByText(
        'An agent is a model with instructions and tools. Create one, or add a plugin that provides some.',
      ),
    ).toBeVisible();
    const create = page.getByRole('link', { name: 'New agent' });
    await expect(create).toHaveAttribute('data-cinder-variant', 'primary');
    await expect(create).toHaveAttribute('href', '/agents/new');
    const browse = page.getByRole('link', { name: 'Browse agents' });
    await expect(browse).toHaveAttribute('data-cinder-variant', 'secondary');
    await expect(browse).toHaveAttribute('href', '/agents');
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await expect(page.locator('[data-testid="first-run"]')).toHaveCount(0);
    await captureForDesignReview(page, { route: '/chats/new', state: 'no agents', source: SOURCE });
    await checkA11y('New chat with no agents');
  });
});

test.describe('New chat when the first message cannot be sent (24c, 24r, 24s)', () => {
  /** Opens Tool runner's New chat with the provider connected, and types the refund request. */
  async function typeRefund(page: Page): Promise<void> {
    await connectProviderWithModels(page);
    await page.clock.setFixedTime(SAMPLE_NOW);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/chats/new?agent=tool-runner');
    await expect(welcome(page)).toBeVisible();
    await field(page).fill(REFUND_ASK);
  }

  test('keeps the typed text, says Interborough didn’t answer with a Retry, and opens no chat page (24c, 24r)', async ({
    page,
    checkA11y,
    pageErrors,
  }) => {
    pageErrors.expectEvery({
      pattern: REFUSED,
      reason: 'the test cuts the first message off on purpose',
    });
    await typeRefund(page);
    let attempts = 0;
    await page.route('**/ag-ui/agents/**', async (route) => {
      attempts += 1;
      await route.abort('connectionfailed');
    });

    await send(page).click();

    const line = failure(page);
    await expect(line).toBeVisible();
    await expect(line).toContainText(
      'Couldn’t start the chat. Interborough didn’t answer. Your text is kept.',
    );
    const retry = line.getByRole('button', { name: 'Retry' });
    await expect(retry).toBeVisible();
    // It sits under the composer, the text is still in the box, and Send is enabled again.
    const composer = await boxOf(page.locator('form.chat-input'));
    const said = await boxOf(line);
    expect(said.y).toBeGreaterThanOrEqual(composer.y + composer.height - 1);
    await expect(field(page)).toHaveValue(REFUND_ASK);
    await expect(send(page)).toBeEnabled();
    await expect(send(page)).not.toContainText('Starting chat…');
    // No chat page opened, the greeting is still the title, and the model selects are still there.
    expect(new URL(page.url()).pathname).toBe('/chats/new');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('What should Tool runner do?');
    await expect(page.getByRole('combobox', { name: 'Model' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: /Permissions/ })).toBeVisible();
    // No alert above the page repeats it: the line under the composer is the one account.
    await expect(page.locator('.cinder-alert')).toHaveCount(0);
    await expect(
      page.getByRole('alert').filter({ hasText: 'Couldn’t start the chat.' }),
    ).toHaveCount(1);
    await captureForDesignReview(page, {
      route: '/chats/new',
      state: 'starting the chat fails',
      source: SOURCE,
    });
    await checkA11y('New chat when the chat could not be started');

    // Retry sends the kept text again.
    await retry.click();
    await expect.poll(() => attempts).toBe(2);
    await expect(failure(page)).toBeVisible();
    await expect(field(page)).toHaveValue(REFUND_ASK);
  });

  test('draws the shell’s banner, and no line of its own, once Interborough cannot be reached (24s)', async ({
    page,
    pageErrors,
  }) => {
    pageErrors.expectEvery({
      pattern: REFUSED,
      reason: 'the test takes the page’s network away on purpose',
    });
    await typeRefund(page);
    // The message is cut off first, and only then every other read: a read the page makes on its
    // own before Send is pressed would tell the shell first, and the composer gives way to its
    // blocked row with nothing sent.
    await page.route('**/ag-ui/agents/**', (route) => route.abort('connectionrefused'));
    await send(page).click();
    // Until the shell knows the server is gone, the page says what happened to the message itself.
    await expect(failure(page)).toBeVisible();
    await page.route(HOST_REQUESTS, (route) => route.abort('connectionrefused'));
    // The person comes back to the tab, which makes every read ask again: the one that finds the
    // server gone.
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));

    const banner = page.getByRole('region', { name: 'Connection problem' });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Can’t reach the Interborough server.');
    await expect(failure(page)).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe('/chats/new');
    await captureForDesignReview(page, {
      route: '/chats/new',
      state: 'starting the chat fails, unreachable',
      source: SOURCE,
    });
  });
});

test.describe('New chat at 375 pixels (24v)', () => {
  test('scrolls the greeting, the stacked Try pills and the wrapping Or chat with row in one column', async ({
    page,
    checkA11y,
  }) => {
    await connectProviderWithModels(page);
    await page.clock.setFixedTime(SAMPLE_NOW);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/chats/new?agent=tool-runner');
    await expect(welcome(page)).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('What should Tool runner do?');
    await expect(
      welcome(page).getByText('Looks an order up, then asks for approval to refund it.'),
    ).toBeVisible();

    // The Try pills are stacked, each on its own line and as wide as the column.
    const prompts = page.getByRole('group', { name: 'Example prompts' }).getByRole('button');
    await expect(prompts).toHaveText([REFUND_ASK, 'Look up order 4398']);
    const first = await boxOf(prompts.nth(0));
    const second = await boxOf(prompts.nth(1));
    expect(second.y).toBeGreaterThanOrEqual(first.y + first.height - 1);
    expect(Math.abs(first.width - second.width)).toBeLessThanOrEqual(2);
    expect(first.x + first.width).toBeLessThanOrEqual(375);

    // Or chat with wraps over more than one line, and holds the other five agents.
    const others = page.getByRole('group', { name: 'Or chat with' }).getByRole('button');
    await expect(others).toHaveCount(5);
    const names = await others.allInnerTexts();
    expect(names.map((name) => name.replaceAll(/\s+/g, ' ').trim())).toEqual([
      'A Assistant',
      'RH Request human input',
      'WA Workflow author',
      'E Echo',
      'MS Model switcher',
    ]);
    const rows = new Set<number>();
    for (let index = 0; index < 5; index += 1) {
      const agentBox = await boxOf(others.nth(index));
      rows.add(Math.round(agentBox.y));
    }
    expect(rows.size).toBeGreaterThan(1);

    // The page does not scroll sideways, and nothing reaches past the screen's edge.
    expect(await scrollsSideways(page)).toBe(false);
    for (const locator of [prompts.nth(0), prompts.nth(1), others.nth(0), others.nth(4)]) {
      const box = await boxOf(locator);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(375);
    }
    // The agent pill, the attach button, one folded Settings select and a 44 pixel Send make the
    // composer's controls.
    await expect(page.getByRole('combobox', { name: 'Agent' })).toContainText('Tool runner');
    await expect(page.getByTestId('composer-settings')).toBeVisible();
    const sendBox = await boxOf(send(page));
    expect(sendBox.height).toBeGreaterThanOrEqual(44);
    await captureForDesignReview(page, {
      route: '/chats/new',
      state: 'phone, provider connected',
      source: SOURCE,
    });
    await checkA11y('New chat at 375px');
  });
});
