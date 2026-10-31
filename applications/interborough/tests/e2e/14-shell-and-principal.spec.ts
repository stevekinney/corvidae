/**
 * The shell as a person meets it: one loopback origin, no sign-in, and one local caller. The top
 * bar holds no principal and no scope count (System's Scopes tab names that caller from
 * `weft.system.principal`), the sidebar holds one ordered list, Chat is the home screen, the palette
 * searches chats and agents first, and Bureau answers beside the engine on the same origin. The
 * notification bell is about the person: what is waiting on them, and what finished.
 */
import type { Page } from '@playwright/test';

import { ROUTE_LOAD_FAILURE_COPY, VIEW_COPY } from '../../src/app/copy.ts';
import { deleteChats, newThreadId, runToEnd } from './chat-support.ts';
import { E2E_BUREAU_URL } from './e2e-constants.ts';
import { expect, loggedFailedResponse, test } from './fixtures.ts';

const WIDTHS = [
  { name: '375', width: 375, height: 812 },
  { name: '1280', width: 1280, height: 800 },
] as const;

const DESTINATIONS = [
  'Chat',
  'Reviews',
  'Agents',
  'Workflows',
  'Runs',
  'Schedules',
  'Health',
  'Settings',
];

test('the top bar names no principal and no scopes, and System’s Scopes tab names the principal weft.system.principal reports', async ({
  page,
  request,
}) => {
  const reported = await request.get('/api/v1/principal');
  expect(reported.ok()).toBe(true);
  const principal = (await reported.json()) as { subject: string; scopes: string[] };
  expect(principal.subject).toBe('anonymous:local');
  expect(principal.scopes.length).toBeGreaterThan(0);

  await page.goto('/');
  const topbar = page.getByRole('banner');
  await expect(topbar.getByRole('button', { name: /^Search everything/ })).toBeVisible();
  const topbarText = (await topbar.textContent()) ?? '';
  expect(topbarText).not.toContain('anonymous:local');
  expect(topbarText).not.toContain('scopes');

  await page.goto('/settings/api-reference?tab=scopes');
  await expect(page.getByTestId('principal-subject')).toHaveText('anonymous:local');
});

/**
 * The bell's three states run on the suite's second host (`e2e-constants.ts`), which no
 * specification before this one has started a run on, so the first state is the host exactly as the
 * seed left it, the way the journey has a host of its own. They run in order and share that host,
 * and they need an E2E server started for this run: a reused one still holds the last run's chats.
 */
test.describe('the notification bell, about the person and not the engine', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ baseURL: E2E_BUREAU_URL });

  const echoThread = newThreadId('bell-echo');
  const approvalThread = newThreadId('bell-approval');
  const questionThread = newThreadId('bell-question');

  // The second host is the one the fresh-host specs read (`24-chat-sessions.spec.ts`,
  // `37-visual-system.spec.ts`), and a reused server would show the next run these chats too.
  test.afterAll(async () => {
    await deleteChats([echoThread, approvalThread, questionThread], E2E_BUREAU_URL);
  });

  /** The panel's rows, which are the bell's items. */
  const rows = (page: Page) => page.locator('.weft-notification-panel__item');
  const bell = (page: Page, name: string | RegExp) => page.getByRole('button', { name });

  test('a fresh host after the seed shows a bell with no badge and no items', async ({
    page,
    checkA11y,
  }) => {
    await page.goto('/agents');
    await expect(bell(page, 'Notifications')).toBeVisible();
    await expect(page.locator('.weft-notification-bell__count')).toHaveCount(0);

    await bell(page, 'Notifications').click();
    await expect(page.getByText('Nothing needs you right now.')).toBeVisible();
    await expect(rows(page)).toHaveCount(0);
    await checkA11y('the empty notification panel');
  });

  test('after one echo chat, one approval and one question there are three items and a badge of 2', async ({
    page,
    request,
    checkA11y,
  }) => {
    await runToEnd(request, 'echo', echoThread, 'Hello echo, say this back', {}, E2E_BUREAU_URL);
    await runToEnd(request, 'tool-runner', approvalThread, 'Refund order 1234', {}, E2E_BUREAU_URL);
    await runToEnd(
      request,
      'request-human-input',
      questionThread,
      'Ship the release',
      {},
      E2E_BUREAU_URL,
    );

    // Not a chat: opening a chat reads its items.
    await page.goto('/agents');
    await expect(bell(page, 'Notifications, 2 need you')).toBeVisible();
    await expect(page.locator('.weft-notification-bell__count')).toHaveText('2');

    await bell(page, 'Notifications, 2 need you').click();
    await expect(rows(page)).toHaveCount(3);
    const panel = page.locator('.weft-notification-panel');
    await expect(
      panel.getByRole('link', { name: /^tool-runner needs your approval in Refund order 1234/ }),
    ).toHaveCount(1);
    await expect(
      panel.getByRole('link', {
        name: /^request-human-input asked a question in Ship the release/,
      }),
    ).toHaveCount(1);
    await expect(
      panel.getByRole('link', { name: /^echo answered in Hello echo, say this back/ }),
    ).toHaveCount(1);

    // The engine's own events, and its run identifiers, stay out of the panel.
    const text = (await panel.textContent()) ?? '';
    expect(text).not.toMatch(/run-\d/);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(text).not.toMatch(/Workflow (started|completed)|Waiting for signal|Signal received/);
    await checkA11y('the notification panel with three items');
  });

  test('approving from the chat clears that item and brings the badge down', async ({ page }) => {
    await page.goto('/agents');
    await expect(bell(page, 'Notifications, 2 need you')).toBeVisible();

    await page.goto(`/chats/${approvalThread}`);
    const approval = page.locator('.ib-decision');
    await expect(approval).toBeVisible();
    await approval.getByRole('button', { name: 'Approve' }).click();
    await expect(approval).toHaveCount(0);

    // Within the default five-second expectation: the decision refreshes the bell at once, and its
    // poll would after five seconds anyway.
    await expect(bell(page, 'Notifications, 1 needs you')).toBeVisible();
    await bell(page, 'Notifications, 1 needs you').click();
    // The question, the echo's answer, and the run's own answer. The approval is gone, and the
    // answer that landed in the chat that is open was read on arrival, so it is not new on leaving.
    await expect(rows(page)).toHaveCount(3);
    await expect(page.getByRole('link', { name: /^tool-runner needs your approval/ })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole('link', { name: /^tool-runner answered in Refund order 1234/ }),
    ).toHaveAttribute('data-read', 'true');
  });

  test('opening an item goes to its chat and reads it', async ({ page }) => {
    await page.goto('/agents');
    await bell(page, 'Notifications, 1 needs you').click();
    await page
      .locator('.weft-notification-panel')
      .getByRole('link', { name: /^request-human-input asked a question/ })
      .click();

    await expect(page).toHaveURL(new RegExp(`/chats/${questionThread}$`));
    await expect(bell(page, 'Notifications')).toBeVisible();
    await expect(page.locator('.weft-notification-bell__count')).toHaveCount(0);
  });

  test('a finished run is listed once the chat is left, and never counts', async ({ page }) => {
    await page.goto('/agents');
    // A fresh page has read nothing, so the question still counts, and the two answers do not.
    await expect(bell(page, 'Notifications, 1 needs you')).toBeVisible();
    await bell(page, 'Notifications, 1 needs you').click();
    await expect(rows(page)).toHaveCount(3);
    await expect(
      page.getByRole('link', { name: /^tool-runner answered in Refund order 1234/ }),
    ).toHaveCount(1);
  });

  test('the panel fits a phone and passes axe', async ({ page, checkA11y }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/agents');
    await bell(page, 'Notifications').click();
    await expect(rows(page).first()).toBeVisible();

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    const panel = await page.locator('.weft-notification-panel').boundingBox();
    expect(panel).not.toBeNull();
    expect((panel?.x ?? -1) >= 0 && (panel?.x ?? 0) + (panel?.width ?? 0) <= 375).toBe(true);
    await checkA11y('the notification panel at 375');
  });
});

for (const { name, width, height } of WIDTHS) {
  test(`the top bar's controls are one height at ${name}`, async ({ page, checkA11y }) => {
    await page.setViewportSize({ width, height });
    await page.goto('/');
    const controls = page.getByRole('banner').locator('.cinder-button:visible');
    await expect(controls.first()).toBeVisible();
    const heights = await controls.evaluateAll((elements) =>
      elements.map((element) => Math.round(element.getBoundingClientRect().height)),
    );
    expect(heights.length).toBeGreaterThanOrEqual(3);
    expect(new Set(heights).size).toBe(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await checkA11y(`shell at ${name}`);
  });
}

test('the palette lists the chat and the agent a few letters name above any run', async ({
  page,
  request,
  checkA11y,
}) => {
  await runToEnd(request, 'echo', newThreadId('palette'), 'Hello echo, say this back');
  await page.goto('/');
  await page.getByRole('button', { name: /^Search everything/ }).click();
  const search = page.getByRole('combobox');
  await expect(search).toHaveAttribute('placeholder', 'Search everything');
  await search.fill('ech');

  const options = page.getByRole('option');
  await expect(page.getByRole('option', { name: /^echo, / })).toHaveCount(1);
  const names = await options.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('aria-label') ?? ''),
  );
  const chatIndex = names.findIndex((label) => label.startsWith('Hello echo, say this back'));
  const agentIndex = names.findIndex((label) => label.startsWith('echo, '));
  expect(chatIndex).toBeGreaterThanOrEqual(0);
  expect(agentIndex).toBeGreaterThan(chatIndex);
  // Neither group of runs the palette also searches (`ech…` ids) comes before them.
  const groups = await page
    .getByRole('dialog', { name: 'Command palette' })
    .getByRole('group')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute('aria-label')));
  expect(groups.slice(0, 2)).toEqual(['Chats', 'Agents']);
  await checkA11y('the palette');
});

test('New chat with echo, from the palette, opens a new chat with that agent', async ({ page }) => {
  await page.goto('/');
  // The shortcut is registered once the shell has mounted, which the top bar's search shows.
  await expect(page.getByRole('button', { name: /^Search everything/ })).toBeVisible();
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill('ech');
  await page.getByRole('option', { name: 'New chat with echo', exact: true }).click();
  await expect(page).toHaveURL(/\/chats\/new\?agent=echo$/);
});

test('g then a letter opens a view, and the sidebar names the keys', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /^Search everything/ })).toBeVisible();
  await page.keyboard.press('g');
  await page.keyboard.press('a');
  await expect(page).toHaveURL(/\/agents$/);
  await page.keyboard.press('g');
  await page.keyboard.press('c');
  await expect(page).toHaveURL(/\/chats$/);
  await expect(page.getByRole('link', { name: /^Agents/ })).toHaveAttribute(
    'title',
    'Agents (g a)',
  );
});

test('the engine status is a dot on Health, with its words in the link’s name', async ({
  page,
}) => {
  await page.goto('/');
  const engine = page.getByRole('link', { name: /^Health\s*Server (healthy|connecting)/ });
  await expect(engine).toHaveCount(1);
  await expect(engine.locator('.cinder-status-dot')).toHaveCount(1);
});

test('an uncredentialed JSON-RPC call is served as that same caller', async ({ request }) => {
  const response = await request.post('/jsonrpc', {
    data: { jsonrpc: '2.0', id: 1, method: 'weft.system.principal', params: {} },
  });
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { result: { subject: string } };
  expect(body.result.subject).toBe('anonymous:local');
});

test('Bureau answers beside the engine on the same origin', async ({ request }) => {
  const health = await request.get('/bureau/v1/health');
  expect(health.ok()).toBe(true);
  const reviews = await request.post('/bureau/jsonrpc', {
    data: { jsonrpc: '2.0', id: 2, method: 'bureau.reviews.list', params: {} },
  });
  expect(reviews.ok()).toBe(true);
});

test('the sidebar holds one ordered list, with Settings pinned to the bottom', async ({ page }) => {
  await page.goto('/');
  const navigation = page.getByRole('navigation', { name: 'Views' });
  await expect(navigation.locator('.cinder-side-navigation-group')).toHaveCount(0);
  const links = navigation.getByRole('link');
  await expect(links).toHaveCount(DESTINATIONS.length);
  for (const [index, label] of DESTINATIONS.entries()) {
    await expect(links.nth(index)).toHaveAccessibleName(new RegExp(`^${label}`));
  }
  // Settings sits below the rest, with the space between them.
  const schedules = await links.nth(5).boundingBox();
  const health = await links.nth(6).boundingBox();
  const settings = await links.nth(7).boundingBox();
  expect((settings?.y ?? 0) - (health?.y ?? 0)).toBeGreaterThan(
    ((health?.y ?? 0) - (schedules?.y ?? 0)) * 2,
  );
});

test('Chat is the home screen, and a session lives under /chats/:chat', async ({ page }) => {
  // The sidebar's item, not the top bar's breadcrumb, which links to the chats from a session.
  const chat = page.getByRole('navigation', { name: 'Views' }).getByRole('link', { name: /^Chat/ });
  await page.goto('/');
  await expect(page.locator('[data-view="chat"]')).toBeVisible();
  await expect(chat).toHaveAttribute('aria-current', 'page');
  await page.goto('/chats/session-1');
  await expect(page.locator('[data-view="chat"]')).toBeVisible();
  await expect(chat).toHaveAttribute('aria-current', 'page');
});

test('runs live at /runs and /runs/:run, and /workflows is the catalog of definitions', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('link', { name: /^Runs/ }).click();
  await expect(page).toHaveURL(/\/runs$/);
  await expect(page.locator('[data-view="runs"]')).toHaveAttribute('data-state', 'ready');

  await page.goto('/runs/nightly-reconciliation-demo');
  await expect(
    page.getByRole('heading', { level: 1, name: 'nightly-reconciliation' }),
  ).toBeVisible();

  await page.goto('/workflows');
  const catalog = page.locator('[data-view="workflows"]');
  await expect(catalog).toHaveAttribute('data-state', 'ready');
  await expect(catalog.getByRole('heading', { level: 1 })).toHaveText(VIEW_COPY.workflows.label);
  await expect(page.locator('[data-view="runs"]')).toHaveCount(0);
});

test('the old paths are gone, and /reviews took the inbox’s place', async ({ request }) => {
  // The route was renamed with no alias: the retired path is not served, and the new one is.
  const retired = await request.get(['', 'inbox'].join('/'));
  expect(retired.status()).toBe(404);
  const reviews = await request.get('/reviews');
  expect(reviews.status()).toBe(200);
});

test('the System view loads its Discovery documents through the relay', async ({ page }) => {
  const documents = [
    page.waitForResponse((response) => new URL(response.url()).pathname === '/openapi.json'),
    page.waitForResponse((response) => new URL(response.url()).pathname === '/openrpc.json'),
  ];
  await page.goto('/settings/api-reference?tab=discovery');
  for (const response of await Promise.all(documents)) expect(response.status()).toBe(200);

  const panel = page.getByRole('tabpanel');
  await expect(panel.getByText('Loading OpenAPI document')).toHaveCount(0);
  await expect(panel.getByRole('table').first()).toBeVisible();
  await expect(panel.getByRole('alert')).toHaveCount(0);

  // The MCP sub-view reads `/.well-known/mcp.json`, which the engine answers only for its own host.
  const mcp = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/.well-known/mcp.json',
  );
  await panel.getByRole('radio', { name: 'MCP' }).click();
  const mcpResponse = await mcp;
  expect(mcpResponse.status()).toBe(200);
  await expect(panel.getByRole('alert')).toHaveCount(0);
});

test('a tab left open past the old idle timeout keeps its event feed, and logs no error', async ({
  page,
}) => {
  // The shell's event feed is quiet between the engine's pings, which are further apart than the
  // 10 seconds Bun waits by default before it closes a silent connection (COR-1643). A cut feed
  // ends without its terminating chunk and Chromium logs `ERR_INCOMPLETE_CHUNKED_ENCODING`.
  const feed = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/v1/events/sse',
  );
  await page.goto('/chats');
  const answered = await feed;
  expect(answered.status()).toBe(200);
  await page.waitForTimeout(12_000);
  // The `pageErrors` fixture fails the test if the feed died.
});

test.describe('a tab opened before the host was rebuilt', () => {
  test('reloads once when a route’s chunk is gone, and shows the route', async ({
    page,
    pageErrors,
  }) => {
    pageErrors.expect({
      pattern: loggedFailedResponse(404, /\/assets\/.*\.js/),
      reason: 'the test removes a route’s chunk, as a rebuild does',
    });
    await page.goto('/chats');
    await expect(page.locator('[data-view="chat"]')).toBeVisible();

    let removed = false;
    await page.route('**/assets/*.js', async (route) => {
      if (removed) {
        await route.fallback();
        return;
      }
      removed = true;
      await route.fulfill({ status: 404, body: 'gone' });
    });
    let loads = 0;
    page.on('load', () => (loads += 1));

    await page.getByRole('link', { name: /^Agents/ }).click();

    await expect(page.locator('[data-view="agents"]')).toHaveAttribute('data-state', 'ready');
    expect(removed).toBe(true);
    expect(loads).toBe(1);
  });

  test('shows the failure instead of reloading again when the chunk is still gone', async ({
    page,
    pageErrors,
  }) => {
    pageErrors.expect({
      pattern: loggedFailedResponse(404, /\/assets\/.*\.js/),
      reason: 'the test removes a route’s chunk for good',
      count: 2,
    });
    await page.goto('/chats');
    await expect(page.locator('[data-view="chat"]')).toBeVisible();

    // The first chunk the Agents route asks for goes missing, and stays missing after the reload.
    let missing: string | undefined;
    await page.route('**/assets/*.js', async (route) => {
      const url = route.request().url();
      missing ??= url;
      if (url === missing) {
        await route.fulfill({ status: 404, body: 'gone' });
        return;
      }
      await route.fallback();
    });
    let loads = 0;
    page.on('load', () => (loads += 1));

    await page.getByRole('link', { name: /^Agents/ }).click();

    await expect(
      page.getByRole('heading', { level: 1, name: ROUTE_LOAD_FAILURE_COPY.title }),
    ).toBeVisible();
    // One reload, not a loop: the page settled on the failure.
    expect(loads).toBe(1);
  });
});
