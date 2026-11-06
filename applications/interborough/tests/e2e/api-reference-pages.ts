/**
 * Where the registry flows used to meet Settings › API reference. The Workflow sources tab folded the
 * registry of workflow types, installed revisions and dynamic sources under its list of workflow
 * files, which the board (PageSettingsSections, "API reference · Workflow sources", row 50y) does not
 * draw, so COR-2019 took it out. No board gives the registry another page yet, so each specification
 * that starts here fails, naming why, until one does.
 */
import type { Page } from '@playwright/test';

/** Where the revision and source flows would open the registry; it has no page yet. */
export async function openWorkflowSources(page: Page): Promise<void> {
  await page.goto('/settings/api-reference?group=sources');
  throw new Error(
    'The workflow registry has no page: Settings › API reference › Workflow sources draws only the workflow files (board row 50y), and no board places the registry elsewhere yet.',
  );
}
