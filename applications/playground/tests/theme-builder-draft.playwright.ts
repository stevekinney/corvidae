import { expect, test, type Page } from '@playwright/test';

import { openBuilder, trackConsoleProblems } from './support/theme-builder.ts';

/**
 * The draft, history and local-storage behavior of the builder in a real browser: real
 * IndexedDB, a real BroadcastChannel between two pages of one browser context, and the
 * browser's own text undo. Each test runs in a fresh browser context, so storage starts empty.
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
// The foundation editor's amount field holds the number; the unit select carries px.
const dimension = (value: number) => String(value);

async function openReady(page: Page, size = { width: 1440, height: 900 }): Promise<void> {
  await openBuilder(page, size);
  await expect(page.getByTestId('save-state')).toHaveText('Saved locally');
}

async function selectRadius(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: 'Token categories' }).getByText('Foundations').click();
  await page.locator('[data-token-path="radius.medium"]').click();
  await expect(page.locator(RADIUS)).toBeVisible();
}

async function applyRadius(page: Page, value: number): Promise<void> {
  await page.locator(RADIUS_UNIT).selectOption('px');
  await page.locator(RADIUS).fill(dimension(value));
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(page.getByTestId('draft-value')).toHaveText(`${value}px`);
  await expect(page.getByTestId('save-state')).toHaveText('Saved locally');
}

const frameRadius = (page: Page) =>
  page.evaluate(() =>
    (
      document.querySelector('iframe') as HTMLIFrameElement
    ).contentDocument!.documentElement.style.getPropertyValue('--cinder-radius-md'),
  );

test.describe('a draft survives a reload', () => {
  test('an edit is restored exactly, with the preview, from IndexedDB', async ({ page }) => {
    await openReady(page);
    await selectRadius(page);
    await applyRadius(page, 5);
    await page.reload();
    await expect(page.getByTestId('draft-ready')).toBeAttached({ timeout: 30_000 });
    await expect(page.getByTestId('save-state')).toHaveText('Saved locally');
    await selectRadius(page);
    await expect(page.locator(RADIUS)).toHaveValue(dimension(5).replace(/ /g, ''));
    await expect(page.getByTestId('draft-value')).toHaveText('5px');
    await expect.poll(() => frameRadius(page)).toBe('5px');
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  });

  test('an unapplied, invalid entry is kept as draft input and restored', async ({ page }) => {
    await openReady(page);
    await selectRadius(page);
    await page.locator(RADIUS).fill('4x');
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(page.locator(RADIUS)).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByTestId('stale-preview')).toBeVisible();
    await expect(page.getByTestId('save-state')).toHaveText('Saved locally', { timeout: 15_000 });
    await page.reload();
    await expect(page.getByTestId('draft-ready')).toBeAttached({ timeout: 30_000 });
    await selectRadius(page);
    await expect(page.locator(RADIUS)).toHaveValue('4x');
    await expect(page.getByTestId('stale-preview')).toBeVisible();
  });
});

test.describe('undo and redo', () => {
  test('the buttons and shortcuts step through committed edits', async ({ page }) => {
    await openReady(page);
    await selectRadius(page);
    await applyRadius(page, 4);
    await applyRadius(page, 6);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByTestId('draft-value')).toHaveText('4px');
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(page.getByTestId('draft-value')).toHaveText('6px');
    await page.locator('h1').focus();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.getByTestId('draft-value')).toHaveText('4px');
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect(page.getByTestId('draft-value')).toHaveText('6px');
  });

  test('inside a text field the browser’s text undo wins and builder history does not run', async ({
    page,
  }) => {
    await openReady(page);
    await selectRadius(page);
    await applyRadius(page, 4);
    await page.locator(RADIUS).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' ');
    await page.keyboard.type('x');
    await expect(page.locator(RADIUS)).toHaveValue(/ x$/);
    await page.keyboard.press('ControlOrMeta+z');
    // The typed text was undone by the browser; the committed edit was not.
    await expect(page.getByTestId('draft-value')).toHaveText('4px');
    await expect(page.locator(RADIUS)).not.toHaveValue(/ x$/);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Redo', exact: true })).toBeDisabled();
  });
});

test.describe('two tabs', () => {
  test('a clean tab reloads the newer revision and announces it', async ({ context, page }) => {
    await openReady(page);
    const other = await context.newPage();
    await openReady(other);
    await selectRadius(page);
    await applyRadius(page, 7);
    await expect(other.getByTestId('workbench-announcer')).toContainText('updated in another tab');
    await selectRadius(other);
    await expect(other.getByTestId('draft-value')).toHaveText('7px');
    await expect(other.getByTestId('conflict-notice')).toHaveCount(0);
  });

  test('a dirty tab is not overwritten and offers Reload stored version or Save as copy', async ({
    context,
    page,
  }) => {
    await openReady(page);
    const other = await context.newPage();
    await openReady(other);
    await selectRadius(other);
    await other.locator(RADIUS).fill('9x');
    await selectRadius(page);
    await applyRadius(page, 7);
    const conflict = other.getByTestId('conflict-notice');
    await expect(conflict).toBeVisible();
    await expect(other.locator(RADIUS)).toHaveValue('9x');

    await conflict.getByRole('button', { name: 'Reload stored version' }).click();
    await other.getByRole('dialog').getByRole('button', { name: 'Discard and reload' }).click();
    await expect(conflict).toHaveCount(0);
    await expect(other.locator(RADIUS)).toHaveValue(dimension(7).replace(/ /g, ''));

    await other.locator(RADIUS).fill('11x');
    await applyRadius(page, 8);
    await expect(conflict).toBeVisible();
    await conflict.getByRole('button', { name: 'Save as copy' }).click();
    await expect(other.getByLabel('Theme', { exact: true })).toContainText('Cinder default 2');
    await expect(conflict).toHaveCount(0);
  });
});

test.describe('the library', () => {
  test('delete names the theme and moves it to Trash; Restore brings it back', async ({ page }) => {
    await openReady(page);
    await page.getByRole('button', { name: 'New theme' }).click();
    await page.getByLabel('Theme name').fill('Ocean');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByTestId('theme-name')).toHaveText('Ocean');

    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Ocean');
    await dialog.getByRole('button', { name: 'Move to Trash' }).click();
    await expect(page.getByTestId('theme-name')).toHaveText('Cinder default');
    await expect(page.getByRole('button', { name: /Trash \(1\)/ })).toBeVisible();

    await page.getByRole('button', { name: /Trash \(1\)/ }).click();
    await page.getByRole('button', { name: 'Restore Ocean' }).click();
    await expect(page.getByTestId('theme-name')).toHaveText('Ocean');
    await expect(page.getByRole('button', { name: /Trash \(0\)/ })).toBeVisible();
  });

  test('permanent delete needs its own confirmation that names what is lost', async ({ page }) => {
    await openReady(page);
    await page.getByRole('button', { name: 'New theme' }).click();
    await page.getByLabel('Theme name').fill('Ocean');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Move to Trash' }).click();
    await page.getByRole('button', { name: /Trash \(1\)/ }).click();
    await page.getByRole('button', { name: 'Delete Ocean permanently' }).click();
    const confirm = page.getByRole('dialog').last();
    await expect(confirm).toContainText('embedded Cinder base');
    await expect(confirm).toContainText('draft');
    await expect(confirm).toContainText('undo history');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Delete Ocean permanently' })).toBeVisible();
    await page.getByRole('button', { name: 'Delete Ocean permanently' }).click();
    await page
      .getByRole('dialog')
      .last()
      .getByRole('button', { name: 'Delete permanently' })
      .click();
    await expect(page.getByRole('button', { name: /Trash \(0\)/ })).toBeVisible();
  });

  test('a rename that collides keeps the dialog open with the error on the field', async ({
    page,
  }) => {
    await openReady(page);
    await page.getByRole('button', { name: 'New theme' }).click();
    await page.getByLabel('Theme name').fill('Ocean');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await page.getByLabel('Theme name').fill('cinder default');
    await page.getByRole('button', { name: 'Rename', exact: true }).last().click();
    await expect(page.getByLabel('Theme name')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByTestId('theme-name')).toHaveText('Ocean');
  });
});

test.describe('scene and tab switches', () => {
  test('keep the selected token and the draft', async ({ page }) => {
    await openReady(page);
    await selectRadius(page);
    await applyRadius(page, 6);
    await page.getByLabel('Preview category').selectOption('Forms');
    await page.getByLabel('Example').selectOption({ index: 1 });
    await expect(page.getByTestId('selected-token-path')).toHaveText('radius.medium');
    await expect(page.getByTestId('draft-value')).toHaveText('6px');
    await expect.poll(() => frameRadius(page)).toBe('6px');
  });

  test('390px: switching Edit, Preview and Checks keeps the token and the draft', async ({
    page,
  }) => {
    await openReady(page, { width: 390, height: 800 });
    await page
      .getByRole('navigation', { name: 'Token categories' })
      .getByText('Foundations')
      .click();
    await page.locator('[data-token-path="radius.medium"]').click();
    await page.getByLabel('Apply to').selectOption('shared');
    await applyRadius(page, 6);
    await page.getByRole('tab', { name: 'Preview' }).click();
    await page.getByRole('tab', { name: 'Checks' }).click();
    await page.getByRole('tab', { name: 'Edit' }).click();
    await expect(page.getByTestId('selected-token-path')).toHaveText('radius.medium');
    await expect(page.getByTestId('draft-value')).toHaveText('6px');
    await expect(page.locator(RADIUS)).toHaveValue(dimension(6).replace(/ /g, ''));
  });
});
