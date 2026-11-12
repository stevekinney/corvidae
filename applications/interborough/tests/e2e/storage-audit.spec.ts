/**
 * The storage explorer and the audit log (COR-1851), driven in a browser against the real host:
 * the key table with its group and starts-with controls, a key's pane, Edit and Delete with a
 * confirmation on a key the application does not manage and a lock on one it does, the storage line
 * with the capabilities popover, the audit log's list and detail, Export as JSON Lines, and the two
 * shortcuts G T and G U. Each page is checked with axe at a phone's width and a desktop's.
 */
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

import { AUDIT_COPY } from '../../src/app/copy/audit.ts';
import { STORAGE_COPY } from '../../src/app/copy/settings.ts';
import { expect, test } from './fixtures.ts';

const WIDTHS = [375, 1280] as const;

const APP_KEY = 'e2e-storage:note';
const APP_VALUE = 'a note from the end-to-end suite';
/** A key under a prefix the Bureau writes (`webhook-delivery:v1:`), which the explorer locks. */
const MANAGED_KEY = 'webhook-delivery:v1:e2e-storage-managed';

const storageUrl = (key: string) => `/v1/storage/${encodeURIComponent(key)}`;

/** Searches the key table, as a person does: type and press Enter. */
async function searchKeys(page: Page, text: string): Promise<void> {
  const search = page.getByLabel(STORAGE_COPY.searchLabel);
  await search.fill(text);
  await search.press('Enter');
}

/** The table row of `key`, which a person clicks to open it. */
const keyButton = (page: Page, key: string) => page.locator(`tr[data-cinder-row-id="${key}"]`);

test.describe('storage', () => {
  test.beforeEach(async ({ request }) => {
    await request.put(storageUrl(APP_KEY), { data: APP_VALUE });
    await request.put(storageUrl(MANAGED_KEY), { data: 'managed' });
  });

  test.afterEach(async ({ request }) => {
    await request.delete(storageUrl(APP_KEY));
    await request.delete(storageUrl(MANAGED_KEY));
  });

  for (const width of WIDTHS) {
    test(`lists keys and opens one at ${width} pixels, and passes axe`, async ({
      page,
      checkA11y,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/health/storage');
      await expect(page.locator('[data-view="storage"]')).toHaveAttribute('data-state', 'ready');
      await expect(page.getByTestId('storage-count')).toBeVisible();
      await checkA11y(`storage — the key table at ${width}px`);

      await searchKeys(page, 'e2e-storage');
      await expect(keyButton(page, APP_KEY)).toBeVisible();
      await keyButton(page, APP_KEY).click();
      await expect(page.getByTestId('storage-key-name')).toHaveText(APP_KEY);
      await expect(page.getByTestId('storage-key')).toContainText(APP_VALUE);
      await checkA11y(`storage — a key open at ${width}px`);
    });
  }

  test('names the backend in use, and opens what the storage can do from that line', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/health/storage');
    const backend = page.getByTestId('storage-backend');
    await expect(backend).toContainText('Running on SQLite in');
    await backend.getByRole('button', { name: 'Storage details' }).click();
    const details = page.getByTestId('storage-details');
    await expect(details.getByText('Backend', { exact: true })).toBeVisible();
    await expect(details.getByText('Keys', { exact: true })).toBeVisible();
  });

  test('narrows the table to one group, and to the keys that start with the search', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/health/storage');
    const group = page.getByLabel(STORAGE_COPY.groupLabel, { exact: true });
    await expect(group.locator('option', { hasText: 'e2e-storage:' })).toHaveCount(1);
    await group.selectOption('e2e-storage:');
    await expect(keyButton(page, APP_KEY)).toBeVisible();
    await expect(page.locator('main tbody tr[data-cinder-row-id]')).toHaveCount(1);

    // Inside a small group the prefix read is short, so it can say that none matches.
    await searchKeys(page, 'no-key-has-this-text');
    await expect(page.getByRole('heading', { name: STORAGE_COPY.noMatches.title })).toBeVisible();
    await page.getByRole('button', { name: STORAGE_COPY.noMatches.clear }).click();
    await expect(page.getByTestId('storage-count')).toBeVisible();
  });

  test('a key the application manages is locked: no Edit, no Delete', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/health/storage');
    const group = page.getByLabel(STORAGE_COPY.groupLabel, { exact: true });
    await expect(group.locator('option', { hasText: 'webhook-delivery:' })).toHaveCount(1);
    await group.selectOption('webhook-delivery:');
    await keyButton(page, MANAGED_KEY).click();
    const pane = page.getByTestId('storage-key');
    await expect(pane.getByTestId('storage-key-managed')).toContainText('webhook-delivery:v1:');
    await expect(pane.getByRole('button', { name: STORAGE_COPY.detail.edit })).toHaveCount(0);
    await expect(pane.getByRole('button', { name: STORAGE_COPY.detail.moreActions })).toHaveCount(
      0,
    );

    // A key of the application, in another group, can be changed.
    await group.selectOption('e2e-storage:');
    await keyButton(page, APP_KEY).click();
    await expect(pane.getByRole('button', { name: STORAGE_COPY.detail.edit })).toBeVisible();
    await expect(pane.getByRole('button', { name: STORAGE_COPY.detail.moreActions })).toBeVisible();
  });

  test('edits a key after a confirmation, and the new value is what storage holds', async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/health/storage');
    await searchKeys(page, 'e2e-storage');
    await keyButton(page, APP_KEY).click();
    const pane = page.getByTestId('storage-key');
    await pane.getByRole('button', { name: STORAGE_COPY.detail.edit }).click();
    await pane.getByRole('textbox', { name: STORAGE_COPY.detail.editLabel }).fill('an edited note');
    await pane.getByRole('button', { name: STORAGE_COPY.detail.save }).click();
    const dialog = page.getByRole('dialog', { name: STORAGE_COPY.confirmSave.title });
    await expect(dialog).toBeVisible();
    const before = await request.get(storageUrl(APP_KEY));
    expect(await before.text()).toBe(APP_VALUE);
    await dialog.getByRole('button', { name: STORAGE_COPY.confirmSave.confirm }).click();

    await expect(pane).toContainText('an edited note');
    const after = await request.get(storageUrl(APP_KEY));
    expect(await after.text()).toBe('an edited note');
  });

  test('deletes a key after a confirmation', async ({ page, request }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/health/storage');
    await searchKeys(page, 'e2e-storage');
    await keyButton(page, APP_KEY).click();
    await page.getByRole('button', { name: STORAGE_COPY.detail.moreActions }).click();
    await page.getByRole('menuitem', { name: STORAGE_COPY.detail.delete }).click();
    const dialog = page.getByRole('dialog', { name: STORAGE_COPY.confirmDelete.title });
    await expect(dialog).toBeVisible();
    const before = await request.get(storageUrl(APP_KEY));
    expect(before.status()).toBe(200);
    await dialog.getByRole('button', { name: STORAGE_COPY.confirmDelete.confirm }).click();

    await expect(keyButton(page, APP_KEY)).toHaveCount(0);
    const after = await request.get(storageUrl(APP_KEY));
    expect(after.status()).toBe(404);
  });
});

test.describe('the audit log', () => {
  for (const width of WIDTHS) {
    test(`lists records and opens one at ${width} pixels, and passes axe`, async ({
      page,
      checkA11y,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/health/audit');
      await expect(page.locator('[data-view="audit"]')).toHaveAttribute('data-state', 'ready');
      const first = page.locator('tbody tr[data-cinder-row-id]').first();
      await expect(first).toBeVisible();
      await checkA11y(`audit log — the table at ${width}px`);

      await first.click();
      const detail = page.getByTestId('audit-detail');
      await expect(detail).toBeVisible();
      await expect(detail).toContainText(AUDIT_COPY.copyAsJson);
      await checkA11y(`audit log — an event open at ${width}px`);
    });
  }

  test('Export saves the trail as JSON Lines, one record per line', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/health/audit');
    await expect(page.locator('tbody tr[data-cinder-row-id]').first()).toBeVisible();

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: AUDIT_COPY.exportAction }).click();
    const file = await download;

    expect(file.suggestedFilename()).toMatch(/^audit-log-\d{4}-\d{2}-\d{2}\.jsonl$/);
    const text = await readFile(await file.path(), 'utf8');
    const lines = text.trimEnd().split('\n');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const parsed = JSON.parse(line) as { timestamp?: unknown; type?: unknown };
      expect(typeof parsed.timestamp).toBe('string');
      expect(typeof parsed.type).toBe('string');
    }
  });
});

test('G T opens Storage and G D opens the audit log', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/agents');
  await expect(page.getByRole('navigation', { name: 'Views' })).toBeVisible();

  await page.keyboard.press('g');
  await page.keyboard.press('t');
  await expect(page).toHaveURL(/\/health\/storage$/);
  await expect(page.locator('[data-view="storage"]')).toHaveAttribute('data-state', 'ready');

  await page.keyboard.press('g');
  await page.keyboard.press('d');
  await expect(page).toHaveURL(/\/health\/audit$/);
  await expect(page.locator('[data-view="audit"]')).toHaveAttribute('data-state', 'ready');
});
