/**
 * What the audit specs share about the Audit log's address. On a fresh visit at a desktop width the
 * page opens the newest event and adds `?record=<key>` (a replace), so the bare `/health/audit` is
 * only a passing moment. Other specifications share the host, so no record key is pinned.
 */
import type { Page } from '@playwright/test';

import { VIEW_COPY } from '../../src/app/copy/view-pages.ts';
import { expect } from './fixtures.ts';

/** Waits for the first audit row or the empty state, then requires the audit path, with or without a record. */
export async function expectAuditSettled(page: Page): Promise<void> {
  const firstRow = page.locator('main tbody tr[data-cinder-row-id]').first();
  const emptyState = page.getByRole('heading', { name: VIEW_COPY.audit.empty?.title ?? '' });
  await expect(firstRow.or(emptyState)).toBeVisible();
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === '/health/audit' &&
      [...url.searchParams.keys()].every((key) => key === 'record'),
  );
}
