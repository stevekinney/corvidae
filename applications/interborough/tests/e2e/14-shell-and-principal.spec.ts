/**
 * The shell as a person meets it: one loopback origin, no sign-in, and one local caller. The
 * shell names that caller from `weft.system.principal`, the sidebar holds the two groups, Chat is
 * the home screen, and Bureau answers beside the engine on the same origin.
 */
import { VIEW_COPY } from '../../src/app/copy.ts';
import { expect, test } from './fixtures.ts';

const PRIMARY = ['Chat', 'Agents', 'Workflows', 'Runs', 'Schedules', 'Inbox'];
const ENGINE = ['Workers', 'Storage', 'System', 'Audit'];

test('the shell shows the principal weft.system.principal reports', async ({ page, request }) => {
  const reported = await request.get('/api/v1/principal');
  expect(reported.ok()).toBe(true);
  const principal = (await reported.json()) as { subject: string; scopes: string[] };
  expect(principal.subject).toBe('anonymous:local');
  expect(principal.scopes.length).toBeGreaterThan(0);

  await page.goto('/');
  await expect(page.getByTestId('principal-subject')).toHaveText('anonymous:local');
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

test('the sidebar holds a Primary group and an Engine group', async ({ page }) => {
  await page.goto('/');
  const navigation = page.getByRole('navigation', { name: 'Views' });
  const groups = navigation.locator('.cinder-side-navigation-group');
  await expect(groups).toHaveCount(2);
  await expect(groups.nth(0).getByRole('button', { name: 'Primary' })).toBeVisible();
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

test('runs live at /runs and /runs/:id, and /workflows is the catalog placeholder', async ({
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
  await expect(catalog).toHaveAttribute('data-state', 'empty');
  await expect(catalog.getByRole('heading', { level: 1 })).toHaveText(
    VIEW_COPY.workflows.empty?.title ?? '',
  );
  await expect(page.locator('[data-view="runs"]')).toHaveCount(0);
});

test('the old paths are gone', async ({ request }) => {
  const reviews = await request.get('/reviews');
  expect(reviews.status()).toBe(404);
});
