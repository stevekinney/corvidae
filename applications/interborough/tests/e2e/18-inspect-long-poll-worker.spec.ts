/**
 * COR-160: an operator sees an HTTP long-poll worker and a WebSocket worker in
 * one fleet and reads the long-poll worker's session state. The worker is a real
 * `LongPollWorker` registered by `e2e-server.ts`, so every field here is what
 * the server reports for a live long-poll session.
 */
import type { Page } from '@playwright/test';

import { E2E_LONG_POLL_DEPLOYMENT_NAME, E2E_LONG_POLL_QUEUE } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
] as const;

async function openLongPollWorker(page: Page): Promise<void> {
  await page.goto('/health/workers');
  const row = page.locator('[data-worker-row]').filter({ hasText: E2E_LONG_POLL_DEPLOYMENT_NAME });
  await expect(row.getByText('HTTP long-poll')).toBeVisible();
  await row.click();
  await expect(page.getByRole('heading', { name: 'Session' })).toBeVisible();
}

function session(page: Page) {
  return page.getByRole('region', { name: 'Session' });
}

test('the list shows both transports together', async ({ page, checkA11y }) => {
  await page.goto('/health/workers');
  const rows = page.locator('[data-worker-row]');
  await expect(rows.filter({ hasText: 'WebSocket' }).first()).toBeVisible();
  await expect(rows.filter({ hasText: 'HTTP long-poll' })).toHaveCount(1);
  await checkA11y('workers—list with both transports');

  await openLongPollWorker(page);
  await expect(page.getByText(/HTTP long-poll workers have no server push/).first()).toBeVisible();
});

test('a long-poll worker shows its lease, its queue, and the transport limit', async ({
  page,
  checkA11y,
}) => {
  await openLongPollWorker(page);

  const region = session(page);
  await expect(region.getByText('No persistent connection')).toBeVisible();
  await expect(region.getByText(/Session lease expires \d{4}-/)).toBeVisible();
  await expect(region.getByText('Authoritative queue')).toBeVisible();
  await expect(region.getByText(E2E_LONG_POLL_QUEUE, { exact: true })).toBeVisible();
  await expect(region.getByText('Connected', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/HTTP long-poll workers have no server push/).first()).toBeVisible();

  await checkA11y('workers—long-poll worker session');
});

test('a WebSocket worker has no lease deadline and says why', async ({ page }) => {
  await page.goto('/health/workers?worker=e2e-fleet-worker-1');
  const region = session(page);
  await expect(region.getByText('The WebSocket is connected.')).toBeVisible();
  await expect(region.getByText(/None\. A WebSocket session has no lease deadline/)).toBeVisible();
});

test('a worker the server does not list reads as closed', async ({ page }) => {
  await page.goto('/health/workers?worker=no-such-worker');
  await expect(page.getByRole('heading', { name: 'Worker closed' })).toBeVisible();
});

test('conformance names that this server registers no targets', async ({ page, checkA11y }) => {
  await page.goto('/health/workers?tab=conformance');
  await expect(page.getByRole('heading', { name: 'No conformance targets' })).toBeVisible();
  await checkA11y('workers—conformance without targets');
});

for (const theme of ['light', 'dark'] as const) {
  test(`long-poll session fits every supported width in the ${theme} theme`, async ({
    page,
    checkA11y,
  }) => {
    await page.addInitScript((selectedTheme) => {
      localStorage.setItem('weft-ui-theme', selectedTheme);
    }, theme);
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      await openLongPollWorker(page);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const label = `long-poll worker (${theme}, ${viewport.width}px)`;
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `${label} page width`,
      ).toBe(true);
      await checkA11y(label);
    }
  });
}
