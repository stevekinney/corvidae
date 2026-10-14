import { expect, test, type Page } from '@playwright/test';

import { openBuilder, trackConsoleProblems } from './support/theme-builder.ts';

/**
 * Composite, alias and recipe editing in a real browser (COR-488): a public shadow edited
 * member by member and reordered with the keyboard, an alias rebound with its impact shown
 * first and undone in one step, a recipe override that rejects `url(…)` and `;`, and the
 * Source and dependencies disclosure with Follow and Back to originating token.
 */

let problems: string[] = [];
test.beforeEach(async ({ page }) => {
  problems = trackConsoleProblems(page);
  await openBuilder(page, { width: 1440, height: 900 });
  await expect(page.getByTestId('save-state')).toHaveText('Saved locally');
});
test.afterEach(() => {
  expect(problems, 'console errors and warnings are defects').toEqual([]);
});

const apply = (page: Page) => page.getByRole('button', { name: 'Apply', exact: true });
const undo = (page: Page) => page.getByRole('button', { name: 'Undo', exact: true });

async function select(page: Page, group: 'Foundations' | 'Semantic', path: string): Promise<void> {
  await page.locator('nav[aria-label="Token categories"] button', { hasText: group }).click();
  await page.locator('#theme-builder-token-filter').fill(path);
  await page.locator(`[data-token-path="${path}"]`).click();
  await expect(page.getByTestId('selected-token-path')).toHaveText(path);
}

const frameVar = (page: Page, name: string) =>
  page.evaluate(
    (property) =>
      (
        document.querySelector('iframe') as HTMLIFrameElement
      ).contentDocument!.documentElement.style.getPropertyValue(property),
    name,
  );

test.describe('shadow composite', () => {
  test('edits one member, reorders layers with the keyboard, and undoes in one step', async ({
    page,
  }) => {
    await select(page, 'Foundations', 'shadow.medium');
    const editor = page.getByTestId('composite-token-editor');
    await expect(editor).toBeVisible();
    await expect(editor.getByTestId('composite-layer')).toHaveCount(2);

    const before = await frameVar(page, '--cinder-shadow-md');
    const blur = editor.locator('input[id$="layer-0-blur-amount"]');
    await blur.fill('9');
    await apply(page).click();
    await expect.poll(() => frameVar(page, '--cinder-shadow-md')).not.toBe(before);
    expect(await frameVar(page, '--cinder-shadow-md')).toContain('9px');

    // Keyboard reorder: focus Move down on layer 1, press Enter, and focus follows the layer.
    const down = editor.getByRole('button', { name: 'Move Shadow layer 1 down' });
    await down.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[aria-live]').filter({ hasText: 'Moved Shadow layer 1' }).first()).toBeAttached();
    await expect(editor.getByRole('button', { name: 'Move Shadow layer 2 up' })).toBeFocused();
    await apply(page).click();
    await expect(page.getByTestId('draft-value')).toContainText('9px');

    await undo(page).click();
    await undo(page).click();
    await expect.poll(() => frameVar(page, '--cinder-shadow-md')).toBe(before);
  });

  test('a malformed member keeps its text, flags the field, and leaves the preview alone', async ({
    page,
  }) => {
    await select(page, 'Foundations', 'shadow.small');
    const editor = page.getByTestId('composite-token-editor');
    const before = await frameVar(page, '--cinder-shadow-sm');
    const blur = editor.locator('input[id$="layer-0-blur-amount"]');
    await blur.fill('abc');
    await expect(blur).toHaveAttribute('aria-invalid', 'true');
    await apply(page).click();
    await expect(blur).toHaveValue('abc');
    expect(await frameVar(page, '--cinder-shadow-sm')).toBe(before);
  });
});

test.describe('alias rebinding', () => {
  test('previews every changed value before Apply, applies once, and one Undo restores it', async ({
    page,
  }) => {
    await select(page, 'Foundations', 'radius.surface');
    const panel = page.getByTestId('reference-panel');
    await expect(panel.getByTestId('reference-alias')).toBeVisible();
    await panel.getByRole('button', { name: 'Rebind alias' }).click();
    await panel.locator('input[id$="-search"]').fill('radius.small');
    const before = await frameVar(page, '--cinder-radius-surface');
    await panel.getByRole('button', { name: 'Alias radius.surface to radius.small' }).click();
    const impact = page.getByTestId('impact-list');
    await expect(impact).toBeVisible();
    await expect(impact.locator('tbody th code').first()).toHaveText('radius.surface');
    // Nothing has changed yet.
    expect(await frameVar(page, '--cinder-radius-surface')).toBe(before);

    await impact.getByRole('button', { name: 'Apply' }).click();
    await expect(impact).toBeHidden();
    await expect.poll(() => frameVar(page, '--cinder-radius-surface')).not.toBe(before);
    await undo(page).click();
    await expect.poll(() => frameVar(page, '--cinder-radius-surface')).toBe(before);
  });

  test('Replace with literal previews first and can be cancelled without a change', async ({
    page,
  }) => {
    await select(page, 'Foundations', 'radius.surface');
    const panel = page.getByTestId('reference-panel');
    await panel.getByRole('button', { name: 'Preview replacing with literal' }).click();
    await expect(page.getByTestId('impact-list')).toBeVisible();
    await page.getByTestId('impact-list').getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('impact-list')).toBeHidden();
    await expect(undo(page)).toBeDisabled();
  });
});

test.describe('recipe override', () => {
  test('rejects url(…) and ; with a path-addressed message, then accepts a typed color', async ({
    page,
  }) => {
    await select(page, 'Semantic', 'surface.hover');
    const panel = page.getByTestId('reference-panel');
    const field = panel.locator('input[id$="-override"]');
    for (const bad of ['url(https://example.com/x.png)', 'red; background: blue']) {
      await field.fill(bad);
      await panel.getByRole('button', { name: 'Preview CSS override' }).click();
      await expect(field).toHaveAttribute('aria-invalid', 'true');
      await expect(panel).toContainText('surface.hover:');
      await expect(page.getByTestId('impact-list')).toBeHidden();
    }
    await expect(undo(page)).toBeDisabled();

    await field.fill('oklch(55% 0.2 270)');
    await panel.getByRole('button', { name: 'Preview CSS override' }).click();
    await expect(page.getByTestId('impact-list')).toBeVisible();
    await page.getByTestId('impact-list').getByRole('button', { name: 'Apply' }).click();
    await expect.poll(() => frameVar(page, '--cinder-surface-hover')).toBe('oklch(55% 0.2 270)');
    await undo(page).click();
    await expect.poll(() => frameVar(page, '--cinder-surface-hover')).not.toBe('oklch(55% 0.2 270)');
  });
});

test.describe('Source and dependencies', () => {
  test('lists dependents by context; Follow and Back return to the originating token', async ({
    page,
  }) => {
    await select(page, 'Foundations', 'radius.large');
    const trigger = page.locator('#theme-source-radius-large-header');
    await trigger.click();
    const disclosure = page.getByTestId('source-disclosure');
    await expect(disclosure.getByTestId('source-revision')).toBeVisible();
    await expect(disclosure.locator('[data-context]')).toHaveCount(6);
    await expect(disclosure.getByTestId('source-disposition')).toContainText('Portable export');

    await disclosure
      .locator('[data-context="light/default"]')
      .getByRole('button', { name: 'Follow dependent overlay.radius' })
      .click();
    await expect(page.getByTestId('selected-token-path')).toHaveText('overlay.radius');
    await page.getByRole('button', { name: 'Back to originating token radius.large' }).click();
    await expect(page.getByTestId('selected-token-path')).toHaveText('radius.large');
    await expect(page.locator('#theme-source-radius-large-header')).toBeFocused();
  });
});
