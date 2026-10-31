/**
 * COR-164: an operator reads a run's worker versioning policy and binding, then previews and
 * confirms a start-time override. Both runs are finished runs of real workflows started against
 * two real builds of one deployment, so every figure is what the server reports (see
 * `versioned-run-seed.ts`).
 *
 * The auto-upgrade run's restart is destructive and happens once, in the last test; the earlier
 * tests only read.
 */
import type { Page } from '@playwright/test';

import {
  E2E_AUTO_UPGRADE_RUN_ID,
  E2E_PINNED_RUN_ID,
  E2E_VERSIONED_DEPLOYMENT_NAME,
  E2E_VERSIONED_FIRST_BUILD_ID,
} from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
] as const;

function panel(page: Page) {
  return page.getByTestId('worker-binding-panel');
}

function figure(page: Page, term: string) {
  return panel(page).getByText(term, { exact: true }).locator('xpath=following-sibling::dd[1]');
}

async function boundGeneration(page: Page, id: string): Promise<number | undefined> {
  const response = await page.request.get(`/api/v1/workflows/${id}`);
  expect(response.ok()).toBe(true);
  const state = (await response.json()) as {
    workerBinding?: { current?: { routingGeneration?: number } };
  };
  return state.workerBinding?.current?.routingGeneration;
}

test('a pinned run shows its binding and says why it cannot be overridden', async ({
  page,
  checkA11y,
}) => {
  await page.goto(`/runs/${E2E_PINNED_RUN_ID}`);
  await expect(panel(page)).toBeVisible();
  await expect(figure(page, 'Policy')).toHaveText('Pinned');
  await expect(figure(page, 'Deployment')).toHaveText(E2E_VERSIONED_DEPLOYMENT_NAME);
  await expect(figure(page, 'Build')).toHaveText(E2E_VERSIONED_FIRST_BUILD_ID);
  await expect(figure(page, 'Routing generation')).toHaveText('1');
  await expect(panel(page).getByTestId('worker-binding-why')).toContainText(
    'Weft never moves a pinned run',
  );
  await expect(panel(page).getByText(/No earlier versions/)).toBeVisible();
  await expect(panel(page).getByText('Workflow-bound and standalone activities')).toBeVisible();
  await checkA11y('workflow detail — pinned worker binding');

  // The restart dialog states the inheritance rule and offers no override.
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Restart' }).click();
  const dialog = page.getByRole('dialog', { name: 'Restart workflow' });
  await expect(dialog.getByText('Worker version for a restart or retry')).toBeVisible();
  await expect(dialog.getByTestId('restart-override-reason')).toContainText('cannot be overridden');
  await expect(dialog.getByRole('button', { name: 'Preview worker upgrade' })).toHaveCount(0);
  await checkA11y('workflow detail — restart dialog for a pinned run');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).not.toBeVisible();
});

test('an auto-upgrade run shows the compatibility it requires and why it may move', async ({
  page,
  checkA11y,
}) => {
  await page.goto(`/runs/${E2E_AUTO_UPGRADE_RUN_ID}`);
  await expect(figure(page, 'Policy')).toHaveText('Auto-upgrade');
  await expect(figure(page, 'Requires build')).toHaveText(E2E_VERSIONED_FIRST_BUILD_ID);
  await expect(figure(page, 'Requires artifact digest')).toHaveText(
    `sha256:${E2E_VERSIONED_FIRST_BUILD_ID}`,
  );
  await expect(panel(page).getByTestId('worker-binding-why')).toContainText(
    'Weft may move it to a routed build',
  );
  await expect(panel(page).getByTestId('worker-binding-override-note')).toContainText(
    'system:admin',
  );
  await checkA11y('workflow detail — auto-upgrade worker binding');
});

test('the worker binding panel is usable across supported widths and themes', async ({ page }) => {
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      await page.goto(`/runs/${E2E_AUTO_UPGRADE_RUN_ID}`);
      await expect(panel(page)).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    }
  }
});

test('an operator previews a worker upgrade, confirms it, and the restart binds at the new generation', async ({
  page,
  checkA11y,
}) => {
  expect(await boundGeneration(page, E2E_AUTO_UPGRADE_RUN_ID)).toBe(1);
  await page.goto(`/runs/${E2E_AUTO_UPGRADE_RUN_ID}`);
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Restart' }).click();
  const dialog = page.getByRole('dialog', { name: 'Restart workflow' });
  await expect(dialog.getByText('Worker version for a restart or retry')).toBeVisible();

  // Nothing is previewed until the operator asks, and a preview alone changes nothing.
  await expect(dialog.getByLabel('Restart on the build routing selects now')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Preview worker upgrade' }).click();
  await expect(dialog.getByText('1 → 2')).toBeVisible();
  const confirmation = dialog.getByLabel('Restart on the build routing selects now');
  await expect(confirmation).not.toBeChecked();
  expect(await boundGeneration(page, E2E_AUTO_UPGRADE_RUN_ID)).toBe(1);
  await checkA11y('workflow detail — worker upgrade preview');

  await confirmation.check();
  await dialog.getByLabel('Signal name').fill('resync');
  await dialog.getByRole('button', { name: 'Restart workflow' }).click();
  await expect(dialog).not.toBeVisible();

  // The replacement carries the previewed generation; a restart without the token would have
  // inherited generation 1.
  await expect.poll(() => boundGeneration(page, E2E_AUTO_UPGRADE_RUN_ID)).toBe(2);
  await page.reload();
  await expect(figure(page, 'Routing generation')).toHaveText('2');
  await expect(figure(page, 'Build')).toHaveText(E2E_VERSIONED_FIRST_BUILD_ID);
  await checkA11y('workflow detail — after worker override');
});
