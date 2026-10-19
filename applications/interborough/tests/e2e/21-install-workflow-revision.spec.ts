/**
 * COR-1464 operator flow against the seeded real Weft server: open System →
 * Registry, drill into `order-processing`, paste a revision manifest into the
 * install control, install it, see it join the revisions list, and open its
 * detail (`weft.workflows.revisions.get`). A manifest the server refuses
 * shows the operation's fault and adds nothing.
 *
 * Installing never activates, and the revision id is fixed, so the spec is
 * safe to leave installed for the rest of the suite (an identical reinstall
 * is idempotent).
 */
import {
  buildConsoleInstallableManifest,
  ORDER_PROCESSING_CONSOLE_INSTALLED_REVISION,
} from '../../fixtures/workflow-revisions.ts';
import { expect, test } from './fixtures.ts';

test('operator installs a revision manifest and reads the installed revision', async ({
  page,
  checkA11y,
}) => {
  const manifest = await buildConsoleInstallableManifest();

  await page.goto('/system?tab=registry');
  await page.getByRole('button', { name: /order-processing/ }).click();

  const revisionsPanel = page.getByRole('region', { name: 'Installed revisions' });
  await expect(revisionsPanel).toBeVisible();

  // A manifest the server refuses: its fault is shown and no row appears.
  const manifestField = revisionsPanel.getByLabel('Revision manifest (JSON)');
  await manifestField.fill(JSON.stringify({ ...manifest, contractHash: 'sha256:wrong' }));
  await revisionsPanel.getByRole('button', { name: 'Install revision' }).click();
  await expect(revisionsPanel.getByRole('alert')).toBeVisible();
  await expect(
    revisionsPanel.getByRole('button', {
      name: `View detail for revision ${ORDER_PROCESSING_CONSOLE_INSTALLED_REVISION}`,
    }),
  ).toHaveCount(0);

  // The valid manifest installs and the list then includes it.
  await manifestField.fill(JSON.stringify(manifest));
  await revisionsPanel.getByRole('button', { name: 'Install revision' }).click();
  await expect(
    revisionsPanel.getByText(`Installed revision "${ORDER_PROCESSING_CONSOLE_INSTALLED_REVISION}"`),
  ).toBeVisible();
  const detailButton = revisionsPanel.getByRole('button', {
    name: `View detail for revision ${ORDER_PROCESSING_CONSOLE_INSTALLED_REVISION}`,
  });
  await expect(detailButton).toBeVisible();

  // Selecting it reads weft.workflows.revisions.get.
  await detailButton.click();
  const detail = revisionsPanel.getByRole('region', {
    name: `Revision ${ORDER_PROCESSING_CONSOLE_INSTALLED_REVISION} detail`,
  });
  await expect(detail).toBeVisible();
  await expect(detail.getByText(manifest.contractHash)).toBeVisible();

  await checkA11y('system — registry revisions panel, installed revision detail');
});
