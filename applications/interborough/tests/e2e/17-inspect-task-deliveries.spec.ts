/**
 * COR-284: an operator reads how the server answered each result a worker
 * submitted. The tasks come from `ledger-evidence-seed.ts`, produced by real
 * remote workers, so the delivery history here is the server's own record.
 *
 * A dead letter needs the result store to fail, which a real host cannot be
 * made to do on demand, so the dead-letter states are covered by the component
 * tests (`task-dead-letter-panel.test.ts`, `task-evidence-route.test.ts`)
 * against the same operations.
 */
import type { Page } from '@playwright/test';

import { E2E_CANCELLED_TASK_OPERATION_ID, E2E_TASK_OPERATION_ID } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
] as const;

async function openTask(page: Page, operationId: string): Promise<void> {
  await page.goto(`/health/workers?tab=diagnostics&task=${operationId}`);
  await expect(page.getByRole('heading', { name: 'Authoritative task ledger' })).toBeVisible();
}

test('an acknowledged cancellation appears as an applied delivery from the worker', async ({
  page,
  checkA11y,
}) => {
  await openTask(page, E2E_CANCELLED_TASK_OPERATION_ID);

  const history = page.getByRole('region', { name: 'Result delivery history' });
  await expect(history).toBeVisible();
  await expect(history.getByText('Acknowledged · applied')).toBeVisible();
  await expect(history.getByText('The result was committed to the ledger.')).toBeVisible();
  await expect(history.getByText('cancelled', { exact: true })).toBeVisible();
  await expect(history.getByText('WebSocket')).toBeVisible();

  // The retained-result panel belongs to dead-lettered tasks only.
  await expect(page.getByText('Retained dead-letter result')).toHaveCount(0);
  await checkA11y('workers—task delivery history');
});

test('a task no worker has answered says so, rather than showing an empty list', async ({
  page,
}) => {
  await openTask(page, E2E_TASK_OPERATION_ID);
  const history = page.getByRole('region', { name: 'Result delivery history' });
  await expect(history.getByText('No results submitted')).toBeVisible();
});

for (const theme of ['light', 'dark'] as const) {
  test(`delivery history fits every supported width in the ${theme} theme`, async ({
    page,
    checkA11y,
  }) => {
    await page.addInitScript((selectedTheme) => {
      localStorage.setItem('weft-ui-theme', selectedTheme);
    }, theme);
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      await openTask(page, E2E_CANCELLED_TASK_OPERATION_ID);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const history = page.getByRole('region', { name: 'Result delivery history' });
      await expect(history.getByText('Acknowledged · applied')).toBeVisible();
      const overflow = await history.evaluate(
        (element) => element.scrollWidth - element.clientWidth,
      );
      expect(overflow, `delivery history overflows at ${viewport.width}px`).toBeLessThanOrEqual(0);
      await checkA11y(`delivery history (${theme}, ${viewport.width}px)`);
    }
  });
}
