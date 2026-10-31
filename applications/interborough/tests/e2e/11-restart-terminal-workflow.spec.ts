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
import { expect, test } from './fixtures.ts';

const WORKFLOW_ID = 'nightly-reconciliation-demo';

/** The lineage stamp of the current run: changes whenever a fresh run replaces it. */
async function readReplacement(
  request: import('@playwright/test').APIRequestContext,
): Promise<string> {
  const response = await request.get(`/api/v1/workflows/${WORKFLOW_ID}`);
  expect(response.ok()).toBe(true);
  const state = (await response.json()) as {
    restartedFrom?: { workflowExecutionToken?: string; replacedAt?: string | number };
  };
  const { workflowExecutionToken, replacedAt } = state.restartedFrom ?? {};
  expect(workflowExecutionToken).toBeTruthy();
  return `${workflowExecutionToken}@${replacedAt}`;
}

test('operator restarts a completed run, seeing the revision it will select first', async ({
  page,
  checkA11y,
}) => {
  // The fixture already restarted this id once, so the lineage chips exist
  // before any click; the stamp is what tells the two runs apart.
  const stampBefore = await readReplacement(page.request);
  await page.goto(`/runs/${WORKFLOW_ID}`);
  await expect(
    page.getByRole('heading', { level: 1, name: 'nightly-reconciliation' }),
  ).toBeVisible();
  // Restart is in the More menu, and only for a terminal run.
  await page.getByRole('button', { name: 'More actions' }).click();
  await expect(page.getByRole('menuitem', { name: 'Restart' })).toBeVisible();

  await page.getByRole('menuitem', { name: 'Restart' }).click();
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

  // Same id, fresh run: the server's lineage stamp changed, so a new run
  // replaced the prior one, and the panel still shows the continuation chain.
  await expect.poll(() => readReplacement(page.request)).not.toBe(stampBefore);
  await expect(page.getByText('Continuation chain · same workflow ID')).toBeVisible();
  await expect(page.getByText('Previous run')).toBeVisible();
  await checkA11y('workflow detail — after restart');
});

test('a run that is not terminal offers no Restart action', async ({ page }) => {
  // `/runs` is the Bureau's list now, so a running engine run is found through the engine's own
  // API and opened by id.
  const running = await page.request.get('/api/v1/workflows', {
    params: { status: 'running', limit: '1' },
  });
  expect(running.ok()).toBe(true);
  const id = ((await running.json()) as { items: Array<{ id: string }> }).items[0]?.id;
  if (id === undefined) throw new Error('The seeded engine has no running workflow.');
  await page.goto(`/runs/${encodeURIComponent(id)}`);
  // A run only the engine knows is titled by its workflow: the page's one level-1 heading.
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await page.getByRole('button', { name: 'More actions' }).click();
  await expect(page.getByRole('menuitem', { name: 'Restart' })).toHaveCount(0);
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
      await page.goto(`/runs/${WORKFLOW_ID}`);

      await page.getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: 'Restart' }).click();
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
