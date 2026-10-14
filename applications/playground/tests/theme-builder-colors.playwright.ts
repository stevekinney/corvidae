import { expect, test, type Page } from '@playwright/test';

import {
  previewFrame,
  selectContext,
  trackConsoleProblems,
  waitForPreviewApplied,
} from './support/theme-builder.ts';

/**
 * The color editor and Create palette in a real browser: the visual picker and the numeric and
 * text controls editing one authored value, light and dark edited independently, a Display P3
 * source kept exactly as authored, an alias that stays linked until it is detached, and a
 * palette proposal applied and undone as one transaction.
 */

let problems: string[] = [];
test.beforeEach(async ({ page }) => {
  problems = trackConsoleProblems(page);
});
test.afterEach(() => {
  expect(problems, 'console errors and warnings are defects').toEqual([]);
});

const ID = 'theme-builder-color-accent-solid';
const field = (page: Page, suffix: string) => page.locator(`[id="${ID}-${suffix}"]`);
const authored = (page: Page) => page.getByTestId('color-authored-text');

async function openColors(page: Page, path = 'accent.solid'): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/theme-builder?filter=color');
  await expect(page.getByTestId('theme-workbench')).toBeVisible();
  await expect(page.getByTestId('draft-ready')).toBeAttached({ timeout: 30_000 });
  await waitForPreviewApplied(page);
  await page.locator(`[data-token-path="${path}"]`).click();
  await expect(page.getByTestId('color-token-editor')).toBeVisible();
}

const apply = (page: Page) => page.getByRole('button', { name: 'Apply', exact: true });
const undo = (page: Page) => page.getByRole('button', { name: 'Undo', exact: true });

const frameVariable = async (page: Page, name: string): Promise<string> => {
  const frame = await previewFrame(page);
  return frame.evaluate(
    (property) => document.documentElement.style.getPropertyValue(property),
    name,
  );
};

test('the picker, the text field and the channel fields edit one authored value', async ({
  page,
}) => {
  await openColors(page);
  await expect(authored(page)).toHaveText('oklch(0.5 0.22 270)');

  // Picker to fields: a keyboard step on the picker's hue slider moves every other control.
  const hue = page.getByTestId('color-picker-region').getByRole('slider', { name: 'Hue' });
  await hue.focus();
  await hue.press('Shift+ArrowRight');
  const afterPicker = await field(page, 'text').inputValue();
  expect(afterPicker).toMatch(/^oklch\(/);
  expect(afterPicker).not.toBe('oklch(0.5 0.22 270)');
  const hueText = afterPicker.replace(')', '').split(' ').at(-1)!;
  await expect(field(page, 'h-input')).toHaveValue(hueText);

  // Fields to text: a channel edit rewrites the text field in the same authored space.
  await field(page, 'l-input').fill('0.45');
  await expect(field(page, 'text')).toHaveValue(new RegExp(`^oklch\\(0\\.45 `));
  await field(page, 'text').fill('oklch(0.4 0.18 250)');
  await expect(field(page, 'l-input')).toHaveValue('0.4');
  await expect(field(page, 'c-input')).toHaveValue('0.18');
  await expect(field(page, 'h-input')).toHaveValue('250');

  await apply(page).click();
  await expect(authored(page)).toHaveText('oklch(0.4 0.18 250)');
  await expect(undo(page)).toBeEnabled();
  await waitForPreviewApplied(page);
  const shown = await page.getByTestId('draft-value').textContent();
  expect(await frameVariable(page, '--cinder-accent-solid')).toBe(shown);
});

test('light and dark are edited independently and compared side by side', async ({ page }) => {
  await openColors(page);
  await field(page, 'text').fill('oklch(0.6 0.1 250)');
  await apply(page).click();
  await expect(page.getByTestId('compare-light')).toContainText('oklch(0.6 0.1 250)');
  await expect(page.getByTestId('compare-dark')).toContainText('oklch(0.72 0.14 270)');

  await selectContext(page, { colorMode: 'dark', motion: 'default' });
  await expect(authored(page)).toHaveText('oklch(0.72 0.14 270)');
  await field(page, 'text').fill('oklch(0.8 0.1 200)');
  await apply(page).click();
  await expect(authored(page)).toHaveText('oklch(0.8 0.1 200)');
  await expect(page.getByTestId('compare-light')).toContainText('oklch(0.6 0.1 250)');
  await expect(page.getByTestId('compare-dark')).toContainText('oklch(0.8 0.1 200)');

  await selectContext(page, { colorMode: 'light', motion: 'default' });
  await expect(authored(page)).toHaveText('oklch(0.6 0.1 250)');

  // Resetting one mode's field leaves the other mode's edit in place.
  await undo(page).click();
  await expect(page.getByTestId('compare-dark')).toContainText('oklch(0.72 0.14 270)');
  await expect(page.getByTestId('compare-light')).toContainText('oklch(0.6 0.1 250)');
});

test('a Display P3 source survives edits, a reload and the picker unconverted', async ({
  page,
}) => {
  await openColors(page);
  await field(page, 'text').fill('color(display-p3 0.2 0.3 0.9)');
  await expect(field(page, 'text')).toHaveValue('color(display-p3 0.2 0.3 0.9)');
  await apply(page).click();
  await expect(page.getByTestId('color-space')).toHaveText('Display P3');
  await expect(authored(page)).toHaveText('color(display-p3 0.2 0.3 0.9)');
  await expect(page.getByTestId('picker-preview-note')).toContainText(
    'leaves the source unchanged',
  );
  await expect(page.getByTestId('color-gamut')).toContainText('Display P3');
  await expect(apply(page)).toBeDisabled();

  // The picker is a disabled preview until the user explicitly chooses to edit through it.
  const hue = page.getByTestId('color-picker-region').getByRole('slider', { name: 'Hue' });
  await expect(hue).toHaveAttribute('aria-disabled', 'true');

  await expect(page.getByTestId('save-state')).toHaveText('Saved locally');
  await page.reload();
  await expect(page.getByTestId('draft-ready')).toBeAttached({ timeout: 30_000 });
  await page.locator('[data-token-path="accent.solid"]').click();
  await expect(page.getByTestId('color-space')).toHaveText('Display P3');
  await expect(authored(page)).toHaveText('color(display-p3 0.2 0.3 0.9)');
  await expect.poll(() => frameVariable(page, '--cinder-accent-solid')).toContain('display-p3');

  // Choosing the picker explicitly is the only way it rewrites the source, and it says so.
  await page.getByRole('button', { name: 'Edit with the picker (writes OKLCH)' }).click();
  await expect(page.getByTestId('color-editor-notice')).toContainText('written as OKLCH');
  await expect(authored(page)).toHaveText('color(display-p3 0.2 0.3 0.9)');
});

test('an alias stays linked until it is detached, and undo restores the link', async ({ page }) => {
  await openColors(page, 'status.neutral.text');
  await expect(page.getByTestId('alias-note')).toContainText('text.default');
  await expect(page.locator('[id="theme-builder-color-status-neutral-text-text"]')).toHaveCount(0);

  await page.getByRole('button', { name: 'Detach alias' }).click();
  await expect(page.getByTestId('color-editor-notice')).toContainText('Detached from');
  await expect(page.locator('[id="theme-builder-color-status-neutral-text-text"]')).toBeVisible();
  // Nothing is committed until Apply.
  await expect(undo(page)).toBeDisabled();
  await apply(page).click();
  await expect(page.getByTestId('alias-note')).toHaveCount(0);
  await expect(undo(page)).toBeEnabled();

  await undo(page).click();
  await expect(page.getByTestId('alias-note')).toBeVisible();
});

test('a palette proposal previews, applies as one transaction, and undoes', async ({ page }) => {
  await openColors(page);
  const shipped = (await authored(page).textContent())!;

  await page.getByRole('button', { name: 'Create palette' }).click();
  await expect(page.getByTestId('palette-panel')).toBeVisible();
  await page.locator('[id="palette-seed"]').fill('#0ea5e9');
  await expect(page.getByTestId('palette-roles-light')).toBeVisible();
  await expect(page.getByTestId('palette-roles-dark')).toBeVisible();
  await expect(
    page.getByTestId('palette-roles-light').getByTestId('palette-proposed').first(),
  ).toHaveText(/^oklch\(/);
  await expect(page.getByTestId('palette-panel')).toContainText('does not check or assert');

  // The preview shows the proposal before Apply; the draft is untouched.
  await page.getByRole('button', { name: 'Preview Application' }).click();
  await expect(page.getByTestId('proposal-preview-note')).toBeVisible();
  await waitForPreviewApplied(page);
  expect(await frameVariable(page, '--cinder-accent-solid')).toContain('68.469%');
  await expect(undo(page)).toBeDisabled();

  await page.getByRole('button', { name: 'Apply palette' }).click();
  await expect(page.getByTestId('palette-panel')).toHaveCount(0);
  await expect(authored(page)).toHaveText('oklch(0.68469 0.14787 237.322)');
  await expect(page.getByTestId('compare-dark')).toContainText('oklch(0.68469 0.14787 237.322)');

  // One undo reverts both modes' roles.
  await undo(page).click();
  await expect(authored(page)).toHaveText(shipped);
  await expect(undo(page)).toBeDisabled();
  await expect(page.getByTestId('compare-dark')).toContainText('oklch(0.72 0.14 270)');
});

test('a locked role and an existing override are never silently replaced', async ({ page }) => {
  await openColors(page);
  await field(page, 'text').fill('oklch(0.6 0.1 250)');
  await apply(page).click();
  await expect(authored(page)).toHaveText('oklch(0.6 0.1 250)');

  await page.getByRole('button', { name: 'Create palette' }).click();
  await page.locator('[id="palette-seed"]').fill('#0ea5e9');
  await expect(page.getByText('Existing overrides')).toBeVisible();
  await page.getByRole('button', { name: 'Apply palette' }).click();
  // The light accent.solid override was not included, so it keeps its value.
  await expect(authored(page)).toHaveText('oklch(0.6 0.1 250)');
  await expect(page.getByTestId('compare-dark')).toContainText('oklch(0.68469 0.14787 237.322)');
});
