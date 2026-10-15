import type { Page } from '@playwright/test';

import {
  announcementText,
  captureKeys,
  expect,
  focusTerminal,
  frames,
  lastClipboardWrite,
  resetSent,
  screenContent,
  sentBytes,
  sideEffects,
  terminalInput,
  test,
  write,
} from './terminal-support.ts';

const ESC = '\u001b';
const BEL = '\u0007';

const exportButton = (page: Page) => page.getByRole('button', { name: 'Export', exact: true });
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Export terminal output' });
const snapshot = (page: Page) => page.getByRole('textbox', { name: 'Terminal output snapshot' });

test.describe('the accessible output dialog', () => {
  test('opens a frozen snapshot, goes stale on new output, refreshes on request and closes to Export', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open();
    await exportButton(page).click();
    await expect(dialog(page)).toBeVisible();
    await expect(snapshot(page)).toHaveAttribute('readonly', '');
    await expect(snapshot(page)).toHaveValue(/developer@corvidae:~\/terminal\$ bun run build/);
    await expect(dialog(page)).toContainText('Download ready');
    await expect
      .poll(async () => await announcementText(page))
      .toContain('Terminal snapshot ready');
    const frozen = await snapshot(page).inputValue();

    await write(page, 'late output\r\n');
    await expect(dialog(page)).toContainText('Snapshot stale');
    expect(await snapshot(page), 'new output never changes the snapshot').toHaveValue(frozen);

    const refresh = dialog(page).getByRole('button', { name: 'Refresh' });
    await refresh.click();
    await expect(snapshot(page)).toHaveValue(/late output/);
    await expect(refresh, 'refresh keeps focus on itself').toBeFocused();
    await expect(dialog(page)).not.toContainText('Snapshot stale');
    await expect
      .poll(async () => await announcementText(page))
      .toContain('Terminal snapshot refreshed');

    await dialog(page).getByRole('button', { name: 'Close' }).last().click();
    await expect(dialog(page)).toBeHidden();
    await expect(exportButton(page), 'close returns focus to Export').toBeFocused();
    expect(await sentBytes(page), 'inspection sends no byte').toEqual([]);
  });

  test('Escape closes it, is not shell input, and focus returns to Export', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open();
    await captureKeys(page);
    await exportButton(page).click();
    await expect(dialog(page)).toBeVisible();
    await resetSent(page);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
    await expect(exportButton(page)).toBeFocused();
    expect(await sentBytes(page), 'the overlay consumed Escape').toEqual([]);
  });

  test('a bound-exceeding snapshot says it is truncated and states the bound', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open({ fixture: 'snapshot-modal-truncated' });
    await expect(dialog(page)).toContainText('Snapshot truncated: earlier output was omitted');
    // The export has its own, larger bound (1 MiB), which this output does not reach.
    await expect(dialog(page)).toContainText('Download ready');
    const text = await snapshot(page).inputValue();
    expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(64 * 1024);
    expect(text.trimEnd().split('\n').at(-1)).toMatch(/^line 1500 \.+$/);
    await expect
      .poll(async () => await announcementText(page))
      .toContain('Terminal snapshot truncated');
  });

  test('a replaced session leaves the snapshot readable and no longer refreshable', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open();
    await exportButton(page).click();
    await expect(dialog(page)).toBeVisible();
    await page.evaluate(() => {
      window.terminalLab!.newSession();
    });
    await expect(dialog(page)).toContainText('the session was replaced');
    await expect(dialog(page).getByRole('button', { name: 'Refresh' })).toBeDisabled();
    await expect(snapshot(page)).toHaveValue(/bun run build/);
  });

  test('every control is a labelled button and Copy puts the snapshot on the clipboard', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open();
    await exportButton(page).click();
    for (const name of ['Refresh', 'Copy', 'Download', 'Close']) {
      await expect(dialog(page).getByRole('button', { name }).last()).toBeVisible();
    }
    await dialog(page).getByRole('button', { name: 'Copy' }).click();
    await expect.poll(async () => await lastClipboardWrite(page)).toMatch(/bun run build/);
  });

  test('listed links are visible https text only, and a keyboard press activates one', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open({ query: { quiet: true, links: true } });
    await write(
      page,
      `docs: https://example.com/docs.\r\n${ESC}]8;;https://evil.example/hidden${BEL}hidden${ESC}]8;;${BEL} javascript:alert(1) ftp://example.com/file`,
    );
    await exportButton(page).click();
    await expect(dialog(page).getByText('Links in this output')).toBeVisible();
    const links = dialog(page).getByRole('button', { name: /^https:/ });
    await expect(links).toHaveCount(1);
    await expect(links.first()).toHaveText('https://example.com/docs');
    await links.first().focus();
    await page.keyboard.press('Enter');
    await expect
      .poll(() => page.evaluate(() => window.terminalLab!.events.links))
      .toEqual(['https://example.com/docs']);
    expect(await sideEffects(page)).toMatchObject({ opened: [], clipboardWrites: [] });
  });
});

test.describe('the output tools', () => {
  test('search finds literal text, steps through matches and closes back to Search', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open({ query: { quiet: true } });
    await write(page, 'alpha beta\r\nbeta gamma\r\ndelta');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const field = page.getByRole('textbox', { name: 'Search terminal output' });
    await expect(field).toBeFocused();
    await field.fill('beta');
    await expect(page.getByText('2 matches.')).toBeVisible();
    await page.getByRole('button', { name: 'Next match' }).click();
    await expect(page.getByText('Match 1 of 2.')).toBeVisible();
    await page.getByRole('button', { name: 'Next match' }).click();
    await expect(page.getByText('Match 2 of 2.')).toBeVisible();
    await expect(page.locator('.xterm-selection div').first()).toBeVisible();
    await field.focus();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Search', exact: true })).toBeFocused();
    expect(await sentBytes(page)).toEqual([]);
  });

  test('the three clears are local: nothing is sent and the right content goes', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open({ query: { quiet: true } });
    await focusTerminal(page);
    await write(page, Array.from({ length: 80 }, (_, index) => `row ${index + 1}`).join('\r\n'));
    await page.getByRole('button', { name: 'Clear screen' }).click();
    await expect.poll(async () => await screenContent(page)).not.toContain('row 80');
    await page.getByRole('button', { name: 'Reset terminal' }).click();
    await expect.poll(async () => await screenContent(page)).toBe('');
    expect(await sentBytes(page)).toEqual([]);
    await expect.poll(async () => await announcementText(page)).toContain('Terminal reset');
  });

  test('the tools stay available when the view is read-only and after the process exits', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open({ query: { state: 'read-only' } });
    await exportButton(page).click();
    await expect(snapshot(page)).toHaveValue(/bun run build/);
    await dialog(page).getByRole('button', { name: 'Close' }).last().click();
    await page.evaluate(() => window.terminalLab!.setProps({ state: 'exited' }));
    await expect(page.getByText('Process exited')).toBeVisible();
    await exportButton(page).click();
    await expect(snapshot(page)).toHaveValue(/bun run build/);
    expect(await page.evaluate(() => window.terminalLab!.session.inputCalls)).toBe(0);
    await frames(page);
    await expect(terminalInput(page)).toHaveCount(1);
  });
});
