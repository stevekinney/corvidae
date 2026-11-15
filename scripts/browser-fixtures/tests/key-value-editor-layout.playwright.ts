import { expect, test, type Locator } from '@playwright/test';
import { fixtureRoute } from './layout-fixture.ts';
const KEY_VALUE_EDITOR_ROUTE = fixtureRoute('key-value-editor');

async function box(locator: Locator) {
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  return bounds!;
}

test.describe('KeyValueEditor row layout', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(KEY_VALUE_EDITOR_ROUTE, { waitUntil: 'load' });
  });

  test('draws each row as one line: key, value and Remove the same height on one top edge, Remove at the end', async ({
    page,
  }) => {
    const row = page.locator('.cinder-key-value-editor__row').first();
    const [key, value] = [row.locator('input').nth(0), row.locator('input').nth(1)];
    const remove = row.getByRole('button', { name: 'Remove HOST' });
    const [keyBox, valueBox, removeBox, rowBox] = await Promise.all([
      box(key),
      box(value),
      box(remove),
      box(row),
    ]);
    expect(Math.abs(keyBox.y - valueBox.y)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(keyBox.y - removeBox.y)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(keyBox.height - removeBox.height)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(keyBox.height - valueBox.height)).toBeLessThanOrEqual(0.5);
    expect(valueBox.x).toBeGreaterThan(keyBox.x + keyBox.width);
    expect(removeBox.x).toBeGreaterThan(valueBox.x + valueBox.width);
    expect(Math.abs(removeBox.x + removeBox.width - (rowBox.x + rowBox.width))).toBeLessThanOrEqual(
      0.5,
    );
    await expect(remove).toHaveText('');
  });

  test('names Key and Value once, above the first row, over their own boxes', async ({ page }) => {
    const editor = page.locator('.cinder-key-value-editor').first();
    const headings = editor.locator('.cinder-key-value-editor__headings');
    await expect(headings).toHaveCount(1);
    await expect(headings).toBeVisible();
    const firstRow = editor.locator('.cinder-key-value-editor__row').first();
    const [keyHeadingBox, valueHeadingBox, keyBox, valueBox] = await Promise.all([
      box(headings.getByText('Key', { exact: true })),
      box(headings.getByText('Value', { exact: true })),
      box(firstRow.locator('input').nth(0)),
      box(firstRow.locator('input').nth(1)),
    ]);
    expect(keyHeadingBox.y + keyHeadingBox.height).toBeLessThanOrEqual(keyBox.y);
    expect(Math.abs(keyHeadingBox.x - keyBox.x)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(valueHeadingBox.x - valueBox.x)).toBeLessThanOrEqual(0.5);
    await expect(editor.getByRole('textbox', { name: 'Key' })).toHaveCount(3);
  });

  test('adds a pair when the empty last row is typed into, keeping focus in place', async ({
    page,
  }) => {
    const editor = page.locator('.cinder-key-value-editor').first();
    const pendingKey = editor
      .locator('.cinder-key-value-editor__row[data-cinder-pending] input')
      .first();
    await pendingKey.click();
    await page.keyboard.type('MODE');
    await expect(editor.getByRole('button', { name: 'Remove MODE' })).toBeVisible();
    await expect(editor.locator('.cinder-key-value-editor__row')).toHaveCount(4);
    await expect(editor.locator('input').nth(4)).toBeFocused();
    await expect(editor.locator('input').nth(4)).toHaveValue('MODE');
  });

  test('in a very narrow container stacks key over value with Remove beside the key', async ({
    page,
  }) => {
    const narrow = page.getByTestId('narrow-key-value-editor');
    const row = narrow.locator('.cinder-key-value-editor__row').first();
    const [keyBox, valueBox, removeBox] = await Promise.all([
      box(row.locator('input').nth(0)),
      box(row.locator('input').nth(1)),
      box(row.getByRole('button', { name: 'Remove REGION' })),
    ]);
    expect(valueBox.y).toBeGreaterThanOrEqual(keyBox.y + keyBox.height);
    expect(Math.abs(removeBox.y - keyBox.y)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(removeBox.height - keyBox.height)).toBeLessThanOrEqual(0.5);
    expect(removeBox.x).toBeGreaterThan(keyBox.x + keyBox.width);
    await expect(narrow.locator('.cinder-key-value-editor__headings')).toBeHidden();
  });
});
