/**
 * COR-15 terminal-restart flow against the seeded real Weft server: open a
 * completed run (`nightly-reconciliation-demo`, `fixtures/restart-lineage.ts`
 * — registered, already restarted once), click Restart, see the revision the
 * restart will select BEFORE confirming, confirm with an initial signal, and
 * land on the fresh run under the same id (its Lineage panel's continuation
 * chain still shows a "Previous run").
 *
 * The restart is a real `weft.workflows.startorsignal` with
 * `onTerminalConflict: 'start-new'`; nothing is mocked. No other spec uses
 * this fixture run, so replacing it again is safe anywhere in the run order.
 */
import { expect, test } from './auth-fixtures.ts';

const WORKFLOW_ID = 'nightly-reconciliation-demo';

test('operator restarts a completed run, seeing the revision it will select first', async ({
  page,
  checkA11y,
}) => {
  await page.goto(`/workflows/${WORKFLOW_ID}`);
  await expect(
    page.getByRole('heading', { level: 1, name: 'nightly-reconciliation' }),
  ).toBeVisible();
  // Restart only renders for a terminal run.
  await expect(page.getByRole('button', { name: 'Restart' })).toBeVisible();

  await page.getByRole('button', { name: 'Restart' }).click();
  const dialog = page.getByRole('dialog', { name: 'Restart workflow' });
  await expect(dialog).toBeVisible();

  // The resolved revision is shown before any confirmation, with the
  // fresh-start hedge.
  await expect(dialog.getByText(/^Selects/)).toBeVisible();
  await expect(dialog.getByText(/can run without consulting the active pointer/)).toBeVisible();

  const confirm = dialog.getByRole('button', { name: 'Restart workflow' });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel('Signal name').fill('resync');
  await expect(confirm).toBeEnabled();
  await checkA11y('workflow detail — restart dialog');

  await confirm.click();
  await expect(dialog).not.toBeVisible();

  // Same id, fresh run: the header settles back to a terminal state and the
  // lineage panel still shows the continuation chain.
  await expect(page.getByText('Continuation chain · same workflow id')).toBeVisible();
  await expect(page.getByText('Previous run')).toBeVisible();
  await checkA11y('workflow detail — after restart');
});

test('a run that is not terminal offers no Restart action', async ({ page }) => {
  await page.goto('/workflows?status=running');
  const firstLink = page.getByRole('table', { name: 'Workflows' }).getByRole('link').first();
  await expect(firstLink).toBeVisible();
  await firstLink.click();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restart' })).toHaveCount(0);
});

test('the restart dialog is usable across supported widths and themes', async ({ page }) => {
  for (const theme of ['light', 'dark'] as const) {
    for (const viewport of [
      { width: 375, height: 812 },
      { width: 768, height: 1024 },
      { width: 1280, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      await page.addInitScript((selectedTheme) => {
        localStorage.setItem('weft-ui-theme', selectedTheme);
      }, theme);
      await page.goto(`/workflows/${WORKFLOW_ID}`);

      await page.getByRole('button', { name: 'Restart' }).click();
      const dialog = page.getByRole('dialog', { name: 'Restart workflow' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel('Signal name')).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).not.toBeVisible();
    }
  }
});
