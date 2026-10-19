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
  await page.goto('/workers?tab=list');
  const row = page.getByRole('row').filter({ hasText: E2E_LONG_POLL_DEPLOYMENT_NAME });
  await expect(row.getByText('HTTP long-poll')).toBeVisible();
  await row.getByRole('link').first().click();
  await expect(page.getByRole('heading', { name: 'Session' })).toBeVisible();
}

function session(page: Page) {
  return page.getByRole('region', { name: 'Session' });
}

test('the fleet lists both transports together', async ({ page, checkA11y }) => {
  await page.goto('/workers?tab=fleet');
  const transports = page.locator('.weft-fleet-view__transports');
  await expect(transports).toContainText('WebSocket');
  await expect(transports).toContainText('1 HTTP long-poll');
  await expect(page.getByText('HTTP long-poll', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/HTTP long-poll workers have no server push/).first()).toBeVisible();
  await checkA11y('workers—fleet with both transports');

  await page.goto('/workers?tab=list');
  const table = page.getByRole('table', { name: 'Workers' });
  await expect(table.getByText('WebSocket').first()).toBeVisible();
  await expect(table.getByText('HTTP long-poll')).toBeVisible();
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
  await page.goto('/workers?tab=list&worker=e2e-fleet-worker-1');
  const region = session(page);
  await expect(region.getByText('The WebSocket is connected.')).toBeVisible();
  await expect(region.getByText(/None\. A WebSocket session has no lease deadline/)).toBeVisible();
});

test('a worker the server does not list reads as closed', async ({ page }) => {
  await page.goto('/workers?tab=list&worker=no-such-worker');
  await expect(page.getByRole('heading', { name: 'Worker closed' })).toBeVisible();
});

test('conformance names that this server registers no targets', async ({ page, checkA11y }) => {
  await page.goto('/workers?tab=conformance');
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
