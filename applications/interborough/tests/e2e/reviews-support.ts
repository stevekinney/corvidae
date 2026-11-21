import type { Locator } from '@playwright/test';

/** Answers through the shared approval row, including its confirmation for irreversible calls. */
export async function approveReview(pane: Locator): Promise<void> {
  const button = pane.getByRole('button', { name: 'Approve', exact: true });
  const card = pane.locator('[data-cinder-layout="row"]');
  const irreversible = (await card.getAttribute('data-cinder-risk')) === 'high';
  await button.click();
  if (irreversible) await pane.getByRole('button', { name: 'Press again to approve' }).click();
}
