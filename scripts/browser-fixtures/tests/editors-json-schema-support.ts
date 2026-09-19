import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

export async function openFirstEditor(page: Page) {
  await page.goto('/page/json-schema-editor?snapshot=1', { waitUntil: 'load' });
  await page.waitForSelector('#app > *', { state: 'visible', timeout: 20_000 });
  const editor = page.locator('.cinder-jse').first();
  await expect(editor).toBeVisible();
  return editor;
}

/** Opens the deliberate JSON editing state and returns its source textarea. */
export async function openJsonEditor(editor: Locator) {
  const textarea = editor.locator('textarea').first();
  if (!(await textarea.isVisible())) {
    await editor.getByRole('button', { name: 'Edit JSON' }).click();
  }
  await expect(textarea).toBeVisible();
  return textarea;
}

export async function fillJson(editor: Locator, value: string) {
  const textarea = await openJsonEditor(editor);
  await textarea.fill(value);
}

export async function jsonValue(editor: Locator) {
  const textarea = await openJsonEditor(editor);
  return textarea.inputValue();
}
