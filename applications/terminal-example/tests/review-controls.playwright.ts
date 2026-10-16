import { expect, test, type Page } from '@playwright/test';

import { connected, enroll, isAlive, screen, terminalInput } from './support.ts';

/** Open the collapsed review controls. */
async function openControls(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Review controls' }).first().click();
  await expect(page.getByRole('heading', { name: 'Review controls' })).toBeVisible();
}

async function choose(page: Page, label: string): Promise<void> {
  await page.getByRole('radio', { name: label, exact: true }).click();
}

const status = (page: Page, text: string | RegExp) =>
  page.getByRole('status').filter({ hasText: text }).first();

test('the review controls are collapsed until asked for', async ({ page }) => {
  await enroll(page);
  await connected(page);
  await expect(page.getByRole('heading', { name: 'Review controls' })).toHaveCount(0);
  await openControls(page);
});

test('the theme switch sets the page theme', async ({ page }) => {
  await enroll(page);
  await connected(page);
  await openControls(page);
  await choose(page, 'Dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await choose(page, 'Light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('autostart=off leaves the page in empty, and New session starts a real session', async ({
  page,
}) => {
  await enroll(page);
  await page.goto('/?autostart=off');
  await expect(status(page, 'No terminal session')).toBeVisible();
  await page.getByRole('button', { name: 'New session' }).click();
  await connected(page);
});

test('Show empty ends the session and shows empty without a replacement', async ({ page }) => {
  await enroll(page);
  await connected(page);
  await openControls(page);
  await page.getByRole('button', { name: 'Show empty' }).click();
  await expect(status(page, 'No terminal session')).toBeVisible();
  await expect(page.getByRole('button', { name: 'New session' })).toBeEnabled();
});

for (const point of ['Loading', 'Connecting'] as const) {
  test(`a session held at ${point.toLowerCase()} stays there until released, and Cancel works`, async ({
    page,
  }) => {
    await enroll(page);
    await connected(page);
    await openControls(page);
    await choose(page, point);
    await page.getByRole('button', { name: 'Start a session' }).click();
    const message = point === 'Loading' ? 'Loading terminal…' : 'Connecting…';
    await expect(status(page, message)).toBeVisible();
    await expect(page.getByTestId('hold-status')).toHaveText(
      new RegExp(`Held at ${point.toLowerCase()}`),
    );
    // Still held after a pause: nothing carries on by itself.
    await page.waitForTimeout(1500);
    await expect(status(page, message)).toBeVisible();
    // Cancel returns to empty and starts nothing.
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(status(page, 'No terminal session')).toBeVisible();
    await expect(page.getByTestId('hold-status')).toHaveText('Nothing is held.');
    // Held again, then released.
    await page.getByRole('button', { name: 'New session' }).click();
    await expect(status(page, message)).toBeVisible();
    await page.getByRole('button', { name: 'Release held session' }).click();
    await connected(page);
  });
}

test('a refused ticket is a real denial with Try again, which works once the fault is off', async ({
  page,
}) => {
  await enroll(page);
  await connected(page);
  await openControls(page);
  await choose(page, 'Denied');
  await page.getByRole('button', { name: 'Start a session' }).click();
  await expect(status(page, 'Access denied')).toBeVisible();
  await expect(terminalInput(page)).toHaveCount(0);
  await choose(page, 'Nothing');
  await page.getByRole('button', { name: 'Try again' }).click();
  await connected(page);
});

test('a refused request is a real failure with Retry, which works once the fault is off', async ({
  page,
}) => {
  await enroll(page);
  await connected(page);
  await openControls(page);
  await choose(page, 'Failed');
  await page.getByRole('button', { name: 'Start a session' }).click();
  await expect(status(page, 'Terminal failed')).toBeVisible();
  await expect(page.getByText('The server refused the request (400).').first()).toBeVisible();
  await choose(page, 'Nothing');
  await page.getByRole('button', { name: 'Retry' }).click();
  await connected(page);
});

test('an injected engine failure says it is injected and its Retry hands control back', async ({
  page,
}) => {
  await enroll(page);
  await connected(page);
  await openControls(page);
  await page.getByRole('button', { name: 'Inject engine load failure' }).click();
  await expect(status(page, 'Terminal engine unavailable')).toBeVisible();
  await expect(page.getByTestId('injection-status')).toContainText('injected by this page');
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByTestId('injection-status')).toHaveText('Showing the session’s own state.');
  await expect(status(page, 'Connected')).toBeVisible();
});

test('an injected cleanup-incomplete ends the session first, offers Check cleanup only, and checking reports the real result', async ({
  page,
}) => {
  await enroll(page);
  await connected(page);
  await openControls(page);
  await page.getByRole('button', { name: 'Inject cleanup incomplete' }).click();
  await expect(status(page, 'Cleanup incomplete')).toBeVisible();
  await expect(page.getByRole('button', { name: 'New session' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Check cleanup' }).click();
  await expect(page.getByTestId('injection-status')).toHaveText('Showing the session’s own state.');
  // The real cleanup finished, so a replacement is offered again.
  await expect(page.getByRole('button', { name: 'New session' })).toBeEnabled();
});

test('the escaped job profile reaches the real Cleanup incomplete, and the escaped process is still there', async ({
  page,
}) => {
  // Whatever fails, the process this test started is ended in `finally`, from whatever pid the
  // screen printed before the failure.
  const printedPid = async (): Promise<number | undefined> => {
    const text = await screen(page)
      .innerText()
      .catch(() => '');
    const match = /escaped=(\d+)/.exec(text);
    return match === null ? undefined : Number(match[1]);
  };
  try {
    await enroll(page);
    await connected(page);
    await openControls(page);
    await choose(page, 'Escaped job');
    // The expanded controls push the terminal below the fold, where the engine does not repaint, so
    // collapse them to bring it into view.
    await page.getByRole('button', { name: 'Review controls' }).first().click();
    await expect.poll(printedPid).toBeDefined();
    const escaped = (await printedPid()) as number;
    await page.getByRole('button', { name: 'End session' }).click();
    // The host cannot prove a process that left the session is gone, so it quarantines the slot.
    await expect(status(page, 'Cleanup incomplete')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('button', { name: 'New session' })).toHaveCount(0);
    expect(isAlive(escaped)).toBe(true);
  } finally {
    // This process belongs to the test, which started it and ends it.
    const escaped = await printedPid();
    if (escaped !== undefined) {
      try {
        process.kill(escaped, 'SIGKILL');
      } catch {
        // It already ended.
      }
    }
  }
});

test('a stalled program holds a long paste as backpressure, keeps the output, and recovers when it reads again', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await enroll(page);
  await connected(page);
  await openControls(page);
  await choose(page, 'Stalled input');
  // The expanded controls push the terminal below the fold, where the engine does not repaint.
  await page.getByRole('button', { name: 'Review controls' }).first().click();
  await expect(screen(page)).toContainText('This program is not reading its input');
  await expect(status(page, 'Connected')).toBeVisible();
  // One long line, as the Copy a long line control puts on the clipboard: under the paste limit,
  // so it skips the review and goes straight to the program, which is not reading.
  await terminalInput(page).evaluate((target) => {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    const line = '0123456789'.repeat(6_000);
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: (type: string) => (type === 'text/plain' ? line : '') },
    });
    target.dispatchEvent(event);
  });
  // Held, not failed: well past the host's two-second acknowledgement deadline the session stands.
  await expect(status(page, 'Backpressure: input paused')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
  await expect(screen(page)).toContainText('This program is not reading its input');
  await page.waitForTimeout(3_000);
  await expect(status(page, 'Backpressure: input paused')).toBeVisible();
  await expect(status(page, 'Terminal failed')).toHaveCount(0);
  // The program reads again after 20 seconds and discards the line: capacity is back.
  await expect(screen(page)).toContainText('Reading again.', { timeout: 40_000 });
  await expect(status(page, 'Connected')).toBeVisible({ timeout: 15_000 });
});

test('Copy a long line puts one long line on the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await enroll(page);
  await connected(page);
  await openControls(page);
  await page.getByRole('button', { name: 'Copy a long line' }).click();
  await expect(page.getByTestId('copy-status')).toContainText('Copied 60000 characters');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toHaveLength(60_000);
  expect(copied).not.toContain('\n');
});

test.describe('links', () => {
  async function openLinksProfile(page: Page): Promise<void> {
    await page.addInitScript(() => {
      // Do not leave the test for the network: record what the page asks to open.
      const opened: unknown[][] = [];
      (window as unknown as { opened: unknown[][] }).opened = opened;
      window.open = (...args: unknown[]) => {
        opened.push(args);
        return null;
      };
    });
    await enroll(page);
    await connected(page);
    await openControls(page);
    await choose(page, 'Links');
    await expect(screen(page)).toContainText('Fixture complete.');
  }

  test('are off by default: Export lists no address', async ({ page }) => {
    await openLinksProfile(page);
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Export terminal output' });
    await expect(dialog.getByRole('textbox', { name: 'Terminal output snapshot' })).toHaveValue(
      /visible-link/,
    );
    await expect(dialog.getByRole('button', { name: /^https:/ })).toHaveCount(0);
    await expect(page.getByTestId('link-status')).toHaveText('No link has been opened.');
  });

  test('on, only visible HTTPS text is offered, and activating it opens it without an opener', async ({
    page,
  }) => {
    await openLinksProfile(page);
    await page.getByRole('switch', { name: 'Open visible HTTPS links' }).click();
    // Turning links on is a settings change, not a new session: the output stays.
    await expect(screen(page)).toContainText('Fixture complete.');
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Export terminal output' });
    const offered = dialog.getByRole('button', { name: /^https:/ });
    await expect(offered).toHaveCount(3);
    const names = await offered.allTextContents();
    expect(names.join('\n')).toContain('https://example.com/visible-link');
    expect(names.join('\n')).toContain('https://example.com/archive.zip?download=1');
    // The OSC 8 destination, the path, the command scheme and the insecure address are never offered.
    for (const refused of ['hidden.example', '/etc/hosts', 'command:', 'vscode:', 'http://']) {
      expect(names.join('\n')).not.toContain(refused);
    }
    await offered.first().focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('link-status')).toContainText('https://example.com/');
    const opened = await page.evaluate(() => (window as unknown as { opened: unknown[][] }).opened);
    expect(opened).toHaveLength(1);
    expect(opened[0]?.[1]).toBe('_blank');
    expect(opened[0]?.[2]).toBe('noopener');
  });
});

test('removing the toolbar while Export is open sends focus to the frame on close', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await enroll(page);
  await connected(page);
  await openControls(page);
  await page.getByRole('button', { name: /^Remove the toolbar in/ }).click();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export terminal output' });
  await expect(dialog).toBeVisible();
  // The countdown ends, the engine's state is replaced, and the Export button is gone while the dialog stays.
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toHaveCount(0, {
    timeout: 15_000,
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();
  const insideFrame = await page.evaluate(
    () => document.activeElement?.closest('.cinder-terminal') !== null,
  );
  expect(insideFrame).toBe(true);
});
