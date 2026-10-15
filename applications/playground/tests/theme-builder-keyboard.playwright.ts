import { expect, test, type Page } from '@playwright/test';

import { openBuilder, previewFrame, trackConsoleProblems } from './support/theme-builder.ts';

/**
 * Keyboard-only operation of the whole builder (COR-254): every stop on a forward and a
 * backward pass shows visible, unobscured focus; the create-edit-undo-export-import workflow
 * runs with the keyboard alone; and every dialog returns focus to the control that opened it,
 * whether it is closed with Escape or with its own button.
 */

let problems: string[] = [];
test.beforeEach(async ({ page }) => {
  problems = trackConsoleProblems(page);
  await openBuilder(page, { width: 1440, height: 1000 });
  await expect(page.getByTestId('save-state')).toHaveText('Saved locally');
});
test.afterEach(() => {
  expect(problems, 'console errors and warnings are defects').toEqual([]);
});

type FocusState = {
  label: string;
  matches: boolean;
  indicator: boolean;
  covered: boolean;
  isFrame: boolean;
};

/** Read the focused element of the current document: its name, its ring, and whether it is covered. */
const readFocus = (): FocusState | null => {
  const element = document.activeElement;
  if (element === null || element === document.body) return null;
  const style = getComputedStyle(element);
  const box = element.getBoundingClientRect();
  const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  const inSvg = element.closest('svg') !== null;
  return {
    label:
      `${element.tagName.toLowerCase()} ${element.getAttribute('aria-label') ?? ''} ${element.id}`.trim(),
    matches: element.matches(':focus-visible'),
    indicator:
      (style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0) ||
      style.boxShadow !== 'none',
    covered:
      !inSvg &&
      top !== null &&
      top !== element &&
      !element.contains(top) &&
      !top.contains(element) &&
      box.width > 0,
    isFrame: element.tagName === 'IFRAME',
  };
};

async function focusState(page: Page): Promise<FocusState | null> {
  const state = await page.evaluate(readFocus);
  if (state?.isFrame !== true) return state;
  const frame = await previewFrame(page);
  return (await frame.evaluate(readFocus)) ?? state;
}

/** Press `key` up to `limit` times, reporting every stop that has no visible, unobscured focus. */
async function pass(page: Page, key: 'Tab' | 'Shift+Tab', limit: number): Promise<string[]> {
  const failures: string[] = [];
  const seen: string[] = [];
  for (let step = 0; step < limit; step += 1) {
    await page.keyboard.press(key);
    const state = await focusState(page);
    if (state === null) continue;
    seen.push(state.label);
    if (!state.matches) failures.push(`${state.label}: not :focus-visible after ${key}`);
    if (!state.indicator && !state.label.startsWith('iframe'))
      failures.push(`${state.label}: no visible focus indicator`);
    if (state.covered) failures.push(`${state.label}: focus is covered`);
  }
  expect(seen.length, `${key} reached focusable controls`).toBeGreaterThan(10);
  return failures;
}

/**
 * Tab until the focused element matches `target`: a CSS selector, or `text=Name` for a control
 * whose label or visible text is exactly Name. Bounded, so a keyboard trap fails loudly.
 */
async function tabTo(page: Page, target: string, limit = 160): Promise<void> {
  for (let step = 0; step < limit; step += 1) {
    await page.keyboard.press('Tab');
    const reached = await page.evaluate((query) => {
      const element = document.activeElement;
      if (element === null) return false;
      if (!query.startsWith('text=')) return element.matches(query);
      const wanted = query.slice('text='.length);
      return (
        element.getAttribute('aria-label') === wanted ||
        (element.textContent ?? '').trim() === wanted
      );
    }, target);
    if (reached) return;
  }
  throw new Error(`The keyboard never reached ${target}.`);
}

test('every tab stop, forward and backward, has visible unobscured focus and no trap', async ({
  page,
}) => {
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await page.keyboard.press('Shift');
  expect(await pass(page, 'Tab', 60), 'forward').toEqual([]);
  expect(await pass(page, 'Shift+Tab', 60), 'backward').toEqual([]);
});

test('the toolbar, library and context controls are reachable by Tab', async ({ page }) => {
  const required = [
    'text=Export',
    'text=Import',
    'text=New theme',
    '#theme-builder-color-mode',
    '#theme-builder-token-filter',
  ];
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  for (const selector of required) {
    await page.locator('body').click({ position: { x: 1, y: 1 } });
    await tabTo(page, selector);
  }
});

test('a keyboard-only edit: filter, select, type, Apply, Undo', async ({ page }) => {
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await tabTo(page, '#theme-builder-token-filter');
  await page.keyboard.type('radius.medium');
  await tabTo(page, '[data-token-path="radius.medium"]');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('selected-token-path')).toHaveText('radius.medium');
  await tabTo(page, '#theme-builder-foundation-radius-medium-amount');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('7');
  await tabTo(page, 'text=Apply');
  const applyFocus = await focusState(page);
  expect(applyFocus?.indicator).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('draft-value')).toHaveText('7rem');
  await expect(page.getByTestId('save-state')).toHaveText('Saved locally');

  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await tabTo(page, 'text=Undo');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('draft-value')).not.toHaveText('7rem');
});

/** Open a dialog from `trigger` with the keyboard and close it with `close`; focus must return. */
async function roundTrip(
  page: Page,
  trigger: ReturnType<Page['getByRole']>,
  dialogName: string | RegExp,
  close: 'Escape' | { button: string },
): Promise<void> {
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: dialogName });
  await expect(dialog).toBeVisible();
  expect(
    await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null),
    'focus moved into the dialog',
  ).toBe(true);
  if (close === 'Escape') await page.keyboard.press('Escape');
  else await dialog.getByRole('button', { name: close.button, exact: true }).press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(trigger).toBeFocused();
}

test('every dialog returns focus to its trigger, by Escape and by its own button', async ({
  page,
}) => {
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await page.keyboard.press('Shift');
  const button = (name: string | RegExp) => page.getByRole('button', { name, exact: true });

  await roundTrip(page, button('New theme'), 'New theme', 'Escape');
  await roundTrip(page, button('New theme'), 'New theme', { button: 'Cancel' });
  await roundTrip(page, button('Rename'), 'Rename theme', 'Escape');
  await roundTrip(page, button('Rename'), 'Rename theme', { button: 'Cancel' });
  await roundTrip(page, button('Delete'), /Move .* to Trash\?/, 'Escape');
  await roundTrip(page, button('Delete'), /Move .* to Trash\?/, { button: 'Cancel' });
  await roundTrip(page, button('Import'), 'Import theme', 'Escape');
  await roundTrip(page, button('Import'), 'Import theme', { button: 'Cancel' });

  const exportButton = button('Export');
  await exportButton.focus();
  await page.keyboard.press('Enter');
  const exporter = page.getByRole('dialog', { name: 'Export theme' });
  await expect(exporter.getByTestId('export-base')).toBeVisible({ timeout: 60_000 });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(exportButton).toBeFocused();
  await exportButton.focus();
  await page.keyboard.press('Enter');
  await expect(exporter.getByTestId('export-base')).toBeVisible({ timeout: 60_000 });
  await exporter.getByRole('button', { name: 'Close', exact: true }).press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(exportButton).toBeFocused();
});

test('trash and permanent delete: nested dialogs return focus one level at a time', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'New theme' }).click();
  await page.getByLabel('Theme name').fill('Ocean');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByTestId('theme-name')).toHaveText('Ocean');
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Move to Trash' }).press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const trash = page.getByRole('button', { name: /Trash \(1\)/ });
  await trash.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Trash' })).toBeVisible();
  const permanent = page.getByRole('button', { name: 'Delete Ocean permanently' });
  await permanent.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(permanent).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(trash).toBeFocused();
});
