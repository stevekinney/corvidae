/**
 * Persona flow (e): drain-a-deployment (plan §11.4).
 *
 * workers → a worker of the deployment → drain the deployment with a reason → status drains →
 * resume.
 *
 * `tests/e2e/e2e-server.ts` registers one real `RemoteWorker` under
 * `E2E_DEPLOYMENT_NAME` (`e2e-constants.ts`) purely as fleet inventory —
 * this spec drains it and then resumes it, leaving the fleet in its
 * original `Healthy` state for any later run against the same server
 * process (immaterial across separate `bun run test:e2e` invocations,
 * since each boots a fresh server, but keeps this spec idempotent within
 * one run too).
 */
import { E2E_DEPLOYMENT_NAME, E2E_FLEET_WORKER_ID } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

test('operator drains and resumes a worker deployment', async ({ page, checkA11y }) => {
  await page.goto(`/health/workers?worker=${E2E_FLEET_WORKER_ID}&tab=queues`);
  const pane = page.getByTestId('worker-detail');
  const detail = page.getByTestId('worker-technical-details');
  const status = pane.locator('.cinder-status-dot').first();
  // See `01-debug-failed-workflow.spec.ts`'s module doc for why the first
  // axe check on every spec is gated behind real content, not the boot
  // skeleton `page.goto()`'s `load` event resolves under.
  await expect(pane).toBeVisible();
  await expect(detail).toBeVisible();
  await expect(
    detail.getByRole('heading', { name: `Deployment ${E2E_DEPLOYMENT_NAME}` }),
  ).toBeVisible();
  await checkA11y('workers — a worker and its deployment');

  await expect(status).toContainText('Connected');

  await detail.getByRole('button', { name: 'Drain deployment' }).click();
  const dialog = page.getByRole('dialog', { name: 'Drain deployment' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(E2E_DEPLOYMENT_NAME)).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Reason' }).fill('e2e rolling deploy verification');
  await checkA11y('workers — drain deployment dialog');

  await dialog.getByRole('button', { name: 'Drain deployment' }).click();
  await expect(dialog).not.toBeVisible();

  // The E2E fleet worker never has in-flight work (`e2e-server.ts` never
  // dispatches it a task), so the engine has nothing to wait out and
  // transitions straight to `drained` rather than a transient `draining`.
  await expect(status).toContainText('Stopped');
  await checkA11y('workers — worker (deployment drained)');

  await detail.getByRole('button', { name: 'Resume deployment' }).click();
  await expect(status).toContainText('Connected');
  await checkA11y('workers — worker (deployment resumed)');
});
