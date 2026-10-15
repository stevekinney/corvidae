import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

import { openBuilder, trackConsoleProblems } from './support/theme-builder.ts';

/**
 * Export and import in a real browser (COR-486): the lossless round trip through the
 * dialogs, a failed import that leaves the draft alone, keyboard-only operation, dialog focus,
 * and the clipboard fallback. Each test runs in a fresh browser context, so storage is empty.
 */

let problems: string[] = [];
test.beforeEach(async ({ page }) => {
  problems = trackConsoleProblems(page);
});
test.afterEach(() => {
  expect(problems, 'console errors and warnings are defects').toEqual([]);
});

const RADIUS = '#theme-builder-foundation-radius-medium-amount';
const RADIUS_UNIT = '#theme-builder-foundation-radius-medium-unit';

async function openReady(page: Page): Promise<void> {
  await openBuilder(page, { width: 1440, height: 900 });
  await expect(page.getByTestId('save-state')).toHaveText('Saved locally');
}

async function setRadius(page: Page, value: number): Promise<void> {
  await page.getByRole('navigation', { name: 'Token categories' }).getByText('Foundations').click();
  await page.locator('[data-token-path="radius.medium"]').click();
  await page.locator(RADIUS_UNIT).selectOption('px');
  await page.locator(RADIUS).fill(String(value));
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByTestId('draft-value')).toHaveText(`${value}px`);
}

const frameRadius = (page: Page) =>
  page.evaluate(() =>
    (
      document.querySelector('iframe') as HTMLIFrameElement
    ).contentDocument!.documentElement.style.getPropertyValue('--cinder-radius-md'),
  );

async function openExport(page: Page) {
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export theme' });
  await expect(dialog.getByTestId('export-base')).toBeVisible({ timeout: 30_000 });
  return dialog;
}

async function openImport(page: Page) {
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  return page.getByRole('dialog', { name: 'Import theme' });
}

async function downloadSource(page: Page): Promise<string> {
  const dialog = await openExport(page);
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: /^Download .*\.cinder-theme\.json$/ }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/-[0-9a-f-]{8}\.cinder-theme\.json$/);
  const saved = await file.path();
  const text = await readFile(saved, 'utf8');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  return text;
}

/** Small text is pasted; a whole exported theme (hundreds of KB) is chosen as a file. */
async function pasteAndCheck(page: Page, text: string) {
  const dialog = await openImport(page);
  if (text.length > 20_000) {
    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'theme.cinder-theme.json',
      mimeType: 'application/json',
      buffer: Buffer.from(text),
    });
  } else {
    await dialog.getByLabel('Or paste JSON').fill(text);
    await dialog.getByRole('button', { name: 'Check pasted JSON' }).click();
  }
  await expect(dialog.getByTestId('import-result')).toBeVisible({ timeout: 30_000 });
  return dialog;
}

test.describe('export and re-import', () => {
  test('the source envelope round-trips to an identical draft', async ({ page }) => {
    await openReady(page);
    await setRadius(page, 5);
    const exported = await downloadSource(page);
    const envelope = JSON.parse(exported) as Record<string, any>;
    expect(envelope['format']).toBe('com.lostgradient.cinder.theme');
    expect(envelope['overrides'].shared.radius.medium.$value).toEqual({ value: 5, unit: 'px' });

    await setRadius(page, 9);
    await expect.poll(() => frameRadius(page)).toBe('9px');

    const dialog = await pasteAndCheck(page, exported);
    await expect(dialog.getByTestId('import-result')).toHaveAttribute(
      'data-outcome',
      'cinder-envelope',
    );
    await expect(dialog.getByTestId('import-headline')).toContainText('Supported Cinder Theme v1');
    await dialog.getByRole('button', { name: 'Apply to this theme' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('draft-value')).toHaveText('5px');
    await expect.poll(() => frameRadius(page)).toBe('5px');

    // One undoable transaction: undo restores the 9px draft.
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByTestId('draft-value')).toHaveText('9px');

    // The re-exported source of an imported copy has the same overrides.
    const copyDialog = await pasteAndCheck(page, exported);
    await copyDialog.getByRole('button', { name: 'Import as a copy' }).click();
    await expect(page.getByTestId('theme-name')).toContainText(/\s2$/);
    const again = JSON.parse(await downloadSource(page)) as Record<string, any>;
    expect(again['overrides']).toEqual(envelope['overrides']);
    expect(again['cssOverrides']).toEqual(envelope['cssOverrides']);
  });

  test('every export is labeled and the complete portable export is blocked with a reason', async ({
    page,
  }) => {
    await openReady(page);
    const dialog = await openExport(page);
    // The shipped theme carries review and advisory items; CSS and DTCG wait for acknowledgement.
    await expect(dialog.getByTestId('export-css-blocked')).toContainText('acknowledgement');
    await dialog.getByLabel(/I have read the \d+ items/).check();
    await expect(dialog.getByTestId('export-source')).toContainText('Cinder Theme v1');
    await expect(dialog.getByTestId('export-source')).toContainText('not a standard DTCG');
    await expect(dialog.getByTestId('export-portable-blocked')).toContainText(
      '4 tokens have no faithful DTCG representation',
    );
    await expect(dialog.getByTestId('export-portable-subset')).toContainText('Subset');
    await expect(dialog.getByTestId('export-css')).toContainText('cinder-theme layer');
    await expect(dialog.getByTestId('export-report')).toContainText('Cinder base');
  });
});

test.describe('a failed import changes nothing', () => {
  test('invalid input and unsupported profiles leave the draft, history and preview as they were', async ({
    page,
  }) => {
    await openReady(page);
    await setRadius(page, 5);
    await expect(page.getByTestId('save-state')).toHaveText('Saved locally');

    const invalid = await pasteAndCheck(
      page,
      '{"radius":{"medium":{"$type":"dimension","$value":"{radius.nowhere}"}}}',
    );
    await expect(invalid.getByTestId('import-result')).toHaveAttribute('data-outcome', 'invalid');
    await expect(invalid.getByRole('button', { name: 'Apply to this theme' })).toBeDisabled();
    await expect(invalid.getByRole('button', { name: 'Import as a copy' })).toBeDisabled();
    await expect(invalid.getByTestId('import-findings')).toContainText('radius.nowhere');
    const download = page.waitForEvent('download');
    await invalid.getByRole('button', { name: 'Download unchanged' }).click();
    const invalidFile = await download;
    expect(invalidFile.suggestedFilename()).toBe('pasted.json');
    await invalid.getByRole('button', { name: 'Cancel' }).click();

    const resolver = await pasteAndCheck(
      page,
      JSON.stringify({
        version: '2025.10',
        sets: {},
        modifiers: { theme: { contexts: {} }, product: { contexts: {} } },
        resolutionOrder: [],
      }),
    );
    await expect(resolver.getByTestId('import-result')).toHaveAttribute(
      'data-outcome',
      'unsupported-profile',
    );
    await expect(resolver.getByTestId('import-axes')).toContainText('product');
    await expect(resolver.getByRole('button', { name: 'Apply to this theme' })).toBeDisabled();
    await resolver.getByRole('button', { name: 'Cancel' }).click();

    await expect(page.getByTestId('draft-value')).toHaveText('5px');
    await expect.poll(() => frameRadius(page)).toBe('5px');
    await expect(page.getByTestId('save-state')).toHaveText('Saved locally');
    await expect(page.getByTestId('preview-revision')).not.toContainText('updating');
    // Only the edit is on the undo stack; an import that failed added nothing.
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  });

  test('an envelope written against another Cinder base opens read-only and is never rebased', async ({
    page,
  }) => {
    await openReady(page);
    const exported = JSON.parse(await downloadSource(page)) as Record<string, any>;
    exported['base'].packageVersion = '0.0.0-other';
    const dialog = await pasteAndCheck(page, JSON.stringify(exported));
    await expect(dialog.getByTestId('import-headline')).toContainText('incompatible Cinder base');
    await expect(dialog.getByTestId('import-base')).toContainText('0.0.0-other');
    await expect(dialog.getByRole('button', { name: 'Apply to this theme' })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Download unchanged' })).toBeEnabled();
  });
});

test.describe('keyboard and focus', () => {
  const insideDialog = (page: Page) =>
    page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null);

  test('Export opens from the keyboard, traps Tab, and Escape returns focus to the button', async ({
    page,
  }) => {
    await openReady(page);
    const trigger = page.getByRole('button', { name: 'Export', exact: true });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Export theme' });
    await expect(dialog.getByTestId('export-base')).toBeVisible({ timeout: 30_000 });
    expect(await insideDialog(page)).toBe(true);
    for (let i = 0; i < 30; i += 1) {
      await page.keyboard.press('Tab');
      expect(await insideDialog(page)).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test('Import is operable without a pointer, from paste to apply, and restores focus', async ({
    page,
  }) => {
    await openReady(page);
    await setRadius(page, 5);
    await setRadius(page, 9);
    const small = JSON.stringify({
      radius: { medium: { $type: 'dimension', $value: { value: 5, unit: 'px' } } },
    });

    const trigger = page.getByRole('button', { name: 'Import', exact: true });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Import theme' });
    await expect(dialog).toBeVisible();
    expect(await insideDialog(page)).toBe(true);

    await dialog.getByLabel('Or paste JSON').focus();
    await page.keyboard.insertText(small);
    await page.getByRole('button', { name: 'Check pasted JSON' }).focus();
    await page.keyboard.press('Enter');
    await expect(dialog.getByTestId('import-result')).toBeVisible({ timeout: 30_000 });
    await expect(dialog.getByTestId('import-announcer')).toContainText('DTCG token document');
    await page.getByRole('button', { name: 'Apply to this theme' }).focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('draft-value')).toHaveText('5px');
    await expect(trigger).toBeFocused();

    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Import theme' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
});

test.describe('clipboard', () => {
  test('a failing clipboard downloads the file instead and says so', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) },
      });
    });
    await openReady(page);
    const dialog = await openExport(page);
    const download = page.waitForEvent('download');
    await dialog.getByRole('button', { name: /^Copy .*\.cinder-theme\.json$/ }).click();
    const copied = await download;
    expect(copied.suggestedFilename()).toMatch(/\.cinder-theme\.json$/);
    await expect(dialog.getByTestId('export-status')).toContainText('downloaded instead');
  });

  test('a working clipboard copies the exact text', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await openReady(page);
    const dialog = await openExport(page);
    await dialog.getByRole('button', { name: /^Copy .*\.validation-report\.json$/ }).click();
    await expect(dialog.getByTestId('export-status')).toContainText('Copied');
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(JSON.parse(text).format).toBe('com.lostgradient.cinder.theme-report');
  });
});
