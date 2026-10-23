/**
 * The shell as a person meets it: one loopback origin, no sign-in, and one local caller. The top
 * bar holds no principal and no scope count (System's Scopes tab names that caller from
 * `weft.system.principal`), the sidebar holds the two groups, Chat is the home screen, the palette
 * searches chats and agents first, and Bureau answers beside the engine on the same origin.
 */
import { VIEW_COPY } from '../../src/app/copy.ts';
import { newThreadId, runToEnd } from './chat-support.ts';
import { expect, test } from './fixtures.ts';

const WIDTHS = [
  { name: '375', width: 375, height: 812 },
  { name: '1280', width: 1280, height: 800 },
] as const;

const PRIMARY = ['Chat', 'Agents', 'Workflows', 'Runs', 'Schedules', 'Reviews'];
const ENGINE = ['Workers', 'Storage', 'System', 'Audit'];

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
  await expect(topbar.getByRole('button', { name: /^Search chats/ })).toBeVisible();
  const topbarText = (await topbar.textContent()) ?? '';
  expect(topbarText).not.toContain('anonymous:local');
  expect(topbarText).not.toContain('scopes');

  await page.goto('/system?tab=scopes');
  await expect(page.getByTestId('principal-subject')).toHaveText('anonymous:local');
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
  await page.getByRole('button', { name: /^Search chats/ }).click();
  const search = page.getByRole('combobox');
  await expect(search).toHaveAttribute('placeholder', 'Search chats, agents, workflows…');
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
  await expect(page.getByRole('button', { name: /^Search chats/ })).toBeVisible();
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill('ech');
  await page.getByRole('option', { name: 'New chat with echo', exact: true }).click();
  await expect(page).toHaveURL(/\/chat\/new\?agent=echo$/);
});

test('g then a letter opens a view, and the sidebar names the keys', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: /^Search chats/ })).toBeVisible();
  await page.keyboard.press('g');
  await page.keyboard.press('a');
  await expect(page).toHaveURL(/\/agents$/);
  await page.keyboard.press('g');
  await page.keyboard.press('c');
  await expect(page).toHaveURL(/\/chat$/);
  await expect(page.getByRole('link', { name: /^Agents/ })).toHaveAttribute(
    'title',
    'Agents (g a)',
  );
});

test('the engine status is a dot, with its words in the link’s name', async ({ page }) => {
  await page.goto('/');
  const engine = page.getByRole('link', { name: /^Engine (healthy|connecting)/ });
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

test('the sidebar holds a Work group and an Engine group', async ({ page }) => {
  await page.goto('/');
  const navigation = page.getByRole('navigation', { name: 'Views' });
  const groups = navigation.locator('.cinder-side-navigation-group');
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(0).getByRole('button', { name: 'Work' })).toBeVisible();
  await expect(groups.nth(1).getByRole('button', { name: 'Engine' })).toBeVisible();
  for (const label of PRIMARY) {
    await expect(groups.nth(0).getByRole('link', { name: new RegExp(`^${label}`) })).toBeVisible();
  }
  for (const label of ENGINE) {
    await expect(groups.nth(1).getByRole('link', { name: new RegExp(`^${label}`) })).toBeVisible();
  }
});

test('Chat is the home screen, and a session lives under /chat/:sessionId', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-view="chat"]')).toBeVisible();
  await expect(page.getByRole('link', { name: /^Chat/ })).toHaveAttribute('aria-current', 'page');
  await page.goto('/chat/session-1');
  await expect(page.locator('[data-view="chat"]')).toBeVisible();
  await expect(page.getByRole('link', { name: /^Chat/ })).toHaveAttribute('aria-current', 'page');
});

test('runs live at /runs and /runs/:id, and /workflows is the catalog of definitions', async ({
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
  await page.goto('/system?tab=discovery');
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
