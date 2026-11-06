/**
 * Where a specification meets Settings › API reference: the Workflow sources tab, whose registry of
 * workflow types, installed revisions and dynamic sources sits folded under the list of workflow
 * files (board PageSettingsSections, "API reference · Workflow sources").
 */
import type { Page } from '@playwright/test';

import { API_REFERENCE_COPY } from '../../src/app/copy.ts';
import { expect } from './fixtures.ts';

/** Opens the Workflow sources tab with the registry unfolded, which the revision and source flows start from. */
export async function openWorkflowSources(page: Page): Promise<void> {
  await page.goto('/settings/api-reference?group=sources');
  const registry = page.getByRole('button', { name: API_REFERENCE_COPY.sources.registryHeading });
  await expect(registry).toBeVisible();
  await registry.click();
  await expect(registry).toHaveAttribute('aria-expanded', 'true');
}
