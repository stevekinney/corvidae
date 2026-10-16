import { expect, test, type Page } from '@playwright/test';

import { connected, isAlive, screen, shellPid, terminalInput, typeLine } from './support.ts';

async function pasteIntoTerminal(page: Page, text: string): Promise<void> {
  await terminalInput(page).evaluate((target, pasted) => {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: (type: string) => (type === 'text/plain' ? pasted : '') },
    });
    target.dispatchEvent(event);
  }, text);
}

test('a dropped connection freezes input, cleans up the process and replays nothing', async ({
  page,
}) => {
  await page.goto('/');
  await connected(page);
  const first = await shellPid(page, 'before');
  await page.getByRole('button', { name: 'Drop connection' }).click();
  await expect(page.getByText('Disconnected').first()).toBeVisible();
  // Input is frozen: the shell never sees this line, and the screen does not show it echoed.
  await terminalInput(page).focus();
  await page.keyboard.type('echo frozen-input');
  await page.keyboard.press('Enter');
  await expect(screen(page)).not.toContainText('frozen-input');
  // The server cleans up on its own, and only then offers a replacement.
  await expect.poll(() => isAlive(first), { timeout: 15_000 }).toBe(false);
  const restart = page.getByRole('button', { name: 'New session' });
  await expect(restart).toBeEnabled();
  await restart.click();
  await connected(page);
  const second = await shellPid(page, 'after');
  expect(second).not.toBe(first);
  // A new session starts empty: no earlier output and no earlier input came with it.
  await expect(screen(page)).not.toContainText('before=');
  await expect(screen(page)).not.toContainText('frozen-input');
});

test('a process that exits ends the session, and restart is a new one', async ({ page }) => {
  await page.goto('/');
  await connected(page);
  const first = await shellPid(page, 'old');
  await typeLine(page, 'exit 3');
  await expect(page.getByText('Process exited').first()).toBeVisible();
  const restart = page.getByRole('button', { name: 'New session' });
  await expect(restart).toBeEnabled();
  await restart.click();
  await connected(page);
  expect(await shellPid(page, 'new')).not.toBe(first);
});

test('a pasted line break is reviewed before it reaches the shell', async ({ page }) => {
  await page.goto('/');
  await connected(page);
  await pasteIntoTerminal(page, 'echo pasted-one\necho pasted-two\n');
  const dialog = page.getByRole('dialog', { name: 'Review paste' });
  await expect(dialog).toBeVisible();
  // Nothing has been sent while the review is open.
  await expect(screen(page)).not.toContainText('pasted-one');
  await dialog.getByRole('button', { name: 'Paste' }).click();
  await expect(screen(page)).toContainText('pasted-two');
});

test('search finds output, and export offers the accessible snapshot', async ({ page }) => {
  await page.goto('/');
  await connected(page);
  await typeLine(page, 'echo needle-in-the-output');
  await expect(screen(page)).toContainText('needle-in-the-output');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search terminal output' }).fill('needle');
  await expect(page.getByText(/match/i).first()).toBeVisible();
  await page.getByRole('button', { name: 'Close search' }).click();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export terminal output' });
  await expect(dialog.getByRole('textbox', { name: 'Terminal output snapshot' })).toHaveValue(
    /needle-in-the-output/,
  );
  await expect(dialog.getByRole('button', { name: 'Download' })).toBeVisible();
});

test('a background job is beyond the cleanup, and the server says so', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await connected(page);
  await typeLine(page, 'sleep 300 & echo job=$!');
  await expect(screen(page)).toHaveText(/job=\d+/);
  const job = Number(/job=(\d+)/.exec(await screen(page).innerText())?.[1]);
  try {
    await page.close();
    // A job the shell put in a group of its own is outside the process group cleanup owns. The
    // host cannot prove it is gone, so it reports unknown and refuses a replacement.
    await expect
      .poll(
        async () => {
          const response = await context.request.get('/session/status');
          const status = (await response.json()) as { slot: string };
          return status.slot;
        },
        { timeout: 20_000 },
      )
      .toBe('quarantined');
    const second = await context.newPage();
    await second.goto('/');
    await expect(second.getByText('Cleanup incomplete').first()).toBeVisible();
    await expect(second.getByRole('button', { name: 'New session' })).toHaveCount(0);
  } finally {
    // This job belongs to the test, which started it and ends it.
    try {
      process.kill(job, 'SIGKILL');
    } catch {
      // It already ended.
    }
  }
});
