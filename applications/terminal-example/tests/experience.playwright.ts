import { expect, test, type BrowserContext, type Page } from '@playwright/test';

import {
  connected,
  enroll,
  isAlive,
  screen,
  shellPid,
  terminalInput,
  typeLine,
} from './support.ts';

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
  await enroll(page);
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
  await enroll(page);
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
  await enroll(page);
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
  await enroll(page);
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

/** The slot state the server reports for this browser: `free`, `busy` or `quarantined`. */
async function slotOf(context: BrowserContext): Promise<string> {
  const response = await context.request.get('/session/status');
  return ((await response.json()) as { slot: string }).slot;
}

/** Wait for a process the test started to appear on the screen as `marker=<pid>`. */
async function printedPid(page: Page, marker: string): Promise<number> {
  await expect(screen(page)).toHaveText(new RegExp(`${marker}=\\d+`));
  return Number(new RegExp(`${marker}=(\\d+)`).exec(await screen(page).innerText())?.[1]);
}

test('a background job and a stopped job end with the session, and a replacement is offered', async ({
  page,
  context,
}) => {
  await enroll(page);
  await connected(page);
  await typeLine(page, 'sleep 300 & echo job=$!');
  const background = await printedPid(page, 'job');
  await typeLine(page, "sh -c 'echo stopped=$$; exec sleep 300'");
  const stopped = await printedPid(page, 'stopped');
  // Control-Z stops the foreground job through the terminal; the shell keeps it as a stopped job.
  await page.keyboard.press('Control+z');
  await expect(screen(page)).toContainText('Stopped');
  try {
    await page.close();
    // A shell on a terminal puts each job in a process group of its own, but they stay in the
    // terminal's session, which is what cleanup owns. Both are ended and the slot is free again.
    await expect
      .poll(() => [isAlive(background), isAlive(stopped)], { timeout: 20_000 })
      .toEqual([false, false]);
    await expect.poll(() => slotOf(context), { timeout: 20_000 }).toBe('free');
    const second = await context.newPage();
    await enroll(second);
    await connected(second);
    await expect(second.getByText('Cleanup incomplete')).toHaveCount(0);
  } finally {
    // These belong to the test, which ends them if cleanup did not.
    for (const pid of [background, stopped]) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // It already ended.
      }
    }
  }
});

test('a job that leaves the session is beyond the cleanup, and the server says so', async ({
  page,
  context,
}) => {
  await enroll(page);
  await connected(page);
  // The forked child starts a session of its own (perl, because macOS has no setsid command), so
  // nothing in the terminal's session reaches it. Its parent stays, so the host can still see it.
  await typeLine(
    page,
    `perl -MPOSIX -e 'if (fork) { wait } else { POSIX::setsid(); $|=1; print "escaped=$$\\n"; exec "sleep", "300" }'`,
  );
  const escaped = await printedPid(page, 'escaped');
  try {
    await page.close();
    // The host cannot prove a process that left the session is gone, so it reports unknown and
    // refuses a replacement.
    await expect.poll(() => slotOf(context), { timeout: 20_000 }).toBe('quarantined');
    const second = await context.newPage();
    await enroll(second);
    await expect(second.getByText('Cleanup incomplete').first()).toBeVisible();
    await expect(second.getByRole('button', { name: 'New session' })).toHaveCount(0);
    expect(isAlive(escaped)).toBe(true);
  } finally {
    // This process belongs to the test, which started it and ends it.
    try {
      process.kill(escaped, 'SIGKILL');
    } catch {
      // It already ended.
    }
  }
});
