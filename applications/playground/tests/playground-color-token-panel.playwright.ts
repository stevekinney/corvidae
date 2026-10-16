import { expect, test, type Page } from '@playwright/test';

import { inlineVariables, trackConsoleProblems } from './support/theme-builder.ts';

/**
 * The documentation shell's color-token entry point. It used to open an independent override
 * panel; it is now a link into the theme builder's catalogue editor, filtered to colors. The
 * old override store is gone, and documentation routes always show shipped Cinder.
 */

const LEGACY_KEY = 'cinder-playground-color-token-overrides';

let problems: string[] = [];
test.beforeEach(async ({ page }) => {
  problems = trackConsoleProblems(page);
});
test.afterEach(() => {
  expect(problems, 'console errors and warnings are defects').toEqual([]);
});

const entry = (page: Page) => page.getByRole('link', { name: 'Edit color tokens', exact: true });

test('the documentation shell links its color entry point to the filtered builder editor', async ({
  page,
}) => {
  await page.goto('/');
  await expect(entry(page)).toBeVisible();
  await expect(entry(page)).toHaveAttribute('href', '/theme-builder?filter=color');

  await entry(page).click();
  await expect(page).toHaveURL(/\/theme-builder\?filter=color$/);
  await expect(page.getByTestId('theme-workbench')).toBeVisible();
  await expect(page.getByTestId('draft-ready')).toBeAttached({ timeout: 30_000 });

  const colors = page.getByRole('button', { name: 'Colors', exact: true });
  await expect(colors).toHaveAttribute('aria-pressed', 'true');
  const count = page.getByTestId('catalogue-count');
  await expect(count).toHaveText(/^\d+ color tokens$/);
  const total = Number((await count.textContent())!.split(' ')[0]);
  expect(total).toBeGreaterThan(83);
  await expect(page.locator('[data-token-row-button]:visible')).toHaveCount(total);
  // Colors from the semantic and component groups are listed together.
  await expect(page.locator('[data-token-path="accent.solid"]')).toBeVisible();
  await expect(page.locator('[data-token-path="button.background"]')).toBeVisible();

  await page.locator('[data-token-path="accent.solid"]').click();
  await expect(page.getByTestId('color-token-editor')).toBeVisible();
  await expect(page.getByTestId('color-space')).toHaveText('OKLCH');
});

test('the old panel and inspector triggers are gone', async ({ page }) => {
  await page.goto('/');
  await expect(entry(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Color token panel' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Token inspector' })).toHaveCount(0);
  await expect(page.locator('#color-token-panel, #token-inspector-panel')).toHaveCount(0);
});

test('documentation routes show shipped Cinder and ignore old session overrides', async ({
  page,
}) => {
  await page.addInitScript((key) => {
    sessionStorage.setItem(
      key,
      JSON.stringify({ light: { '--cinder-accent-solid': 'rgb(255 0 0)' }, dark: {} }),
    );
  }, LEGACY_KEY);
  await page.goto('/');
  await expect(page.locator('[data-component-page] .dx-hero h1')).toBeVisible();
  expect(await inlineVariables(page), 'the landing page carries no inline token override').toEqual(
    [],
  );
});

test('the builder keeps the old session data for download until it is cleared', async ({
  page,
}) => {
  const raw = JSON.stringify({ light: { '--cinder-accent-solid': 'rgb(255 0 0)' }, dark: {} });
  await page.addInitScript(
    ([key, value]) => sessionStorage.setItem(key!, value!),
    [LEGACY_KEY, raw],
  );
  await page.goto('/theme-builder?filter=color');
  await expect(page.getByTestId('draft-ready')).toBeAttached({ timeout: 30_000 });
  const stored = await page.evaluate((key) => sessionStorage.getItem(key), LEGACY_KEY);
  expect(stored).toBe(raw);
});
