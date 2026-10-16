import { expect, test, type Page } from '@playwright/test';

import { connected, enroll, screen, terminalInput } from './support.ts';

async function chooseProfile(page: Page, label: string): Promise<void> {
  await page.getByRole('radio', { name: label }).click();
}

test('the full-screen program uses the alternate screen and leaves it on q', async ({ page }) => {
  await enroll(page);
  await connected(page);
  await chooseProfile(page, 'Full-screen program');
  await expect(screen(page)).toContainText('Keys received: 0');
  await terminalInput(page).focus();
  await page.keyboard.type('xyz');
  await expect(screen(page)).toContainText('Keys received: 3');
  await page.keyboard.type('q');
  await expect(page.getByText('Process exited').first()).toBeVisible();
  // The program restored the screen it took over.
  await expect(screen(page)).not.toContainText('Keys received');
});

test('the pipe demo keeps standard output and standard error in separate views', async ({
  page,
}) => {
  await enroll(page);
  await connected(page);
  await chooseProfile(page, 'Pipe demo');
  const output = page.locator('.stage').filter({ hasText: 'Standard output' });
  const errors = page.locator('.stage').filter({ hasText: 'Standard error' });
  await expect(screen(page, output)).toContainText('out done: exit 3');
  await expect(screen(page, errors)).toContainText('err done: finished with a failure');
  await expect(screen(page, output)).not.toContainText('err ');
  await expect(screen(page, errors)).not.toContainText('out ');
  // A pipe is not a terminal: nothing here takes input.
  await expect(page.getByText('Read-only').first()).toBeVisible();
});

test('the replay shows the same bytes every time and takes no input', async ({ page }) => {
  await enroll(page);
  await connected(page);
  await chooseProfile(page, 'Replay');
  await expect(page.getByText('Read-only').first()).toBeVisible();
  await expect(screen(page)).toContainText('Replay complete.');
  await expect(screen(page)).toContainText('café');
  const first = await screen(page).innerText();
  await page.getByRole('button', { name: 'New session' }).click();
  await expect(screen(page)).toContainText('Replay complete.');
  expect(await screen(page).innerText()).toBe(first);
});

test('read-only mode sends nothing to the shell', async ({ page }) => {
  await enroll(page);
  await connected(page);
  await page.getByRole('switch', { name: 'Open read-only' }).click();
  await expect(page.getByText('Read-only').first()).toBeVisible();
  await expect(screen(page)).toContainText('$');
  await terminalInput(page).focus();
  await page.keyboard.type('echo should-not-run');
  await page.keyboard.press('Enter');
  await expect(screen(page)).not.toContainText('should-not-run');
  // Selection and scrolling keep working, and the toolbar's tools are still there.
  await expect(page.getByRole('button', { name: 'Search' })).toBeEnabled();
});
