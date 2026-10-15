import type { Page } from '@playwright/test';

import {
  announcedCount,
  bytes,
  captureButton,
  captureKeys,
  expect,
  resetSent,
  sentBytes,
  test,
  write,
} from './terminal-support.ts';

const ESC = '\u001b';
const TRACKING_ON = `${ESC}[?1000h${ESC}[?1006h`;

/** The viewport position of the middle of a character cell, counted from one. */
async function cellCenter(
  page: Page,
  column: number,
  row: number,
): Promise<{ x: number; y: number }> {
  const screen = (await page.locator('.xterm-screen').boundingBox())!;
  const rows = await page.locator('.cinder-terminal__viewport .xterm-rows > div').count();
  const width = await page
    .locator('.xterm-char-measure-element')
    .first()
    .evaluate(
      (element) => element.getBoundingClientRect().width / (element.textContent?.length ?? 1),
    );
  const height = screen.height / rows;
  return {
    x: screen.x + (column - 0.5) * width,
    y: screen.y + (row - 0.5) * height,
  };
}

async function drag(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const start = await cellCenter(page, ...from);
  const end = await cellCenter(page, ...to);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 5 });
  await page.mouse.up();
}

const selection = (page: Page) => page.locator('.xterm-selection div');
const badge = (page: Page) =>
  page.locator('.cinder-terminal__actions').getByText('Mouse reporting on', { exact: true });

test.describe('the program tracks the mouse, and reporting is not permitted', () => {
  test('with the prop off, a real drag selects text and sends no mouse bytes', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open();
    await write(page, TRACKING_ON);
    await drag(page, [1, 1], [12, 1]);
    await expect(selection(page).first()).toBeVisible();
    expect(await sentBytes(page)).toEqual([]);
    await expect(badge(page)).toHaveCount(0);

    // Capture does not change that: the host has not enabled reporting.
    await captureKeys(page);
    await page.mouse.click(5, 5);
    await resetSent(page);
    await drag(page, [1, 2], [10, 2]);
    await expect(selection(page).first()).toBeVisible();
    expect(await sentBytes(page)).toEqual([]);
    await expect(badge(page)).toHaveCount(0);
  });

  test('with the prop on but capture off, a real drag still selects and sends nothing', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open({ query: { mouse: true } });
    await write(page, TRACKING_ON);
    await drag(page, [1, 1], [12, 1]);
    await expect(selection(page).first()).toBeVisible();
    expect(await sentBytes(page)).toEqual([]);
    await expect(badge(page)).toHaveCount(0);
  });

  test('a view that is not writable never reports the mouse, whatever the prop says', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open({ query: { mouse: true, state: 'read-only' } });
    await write(page, TRACKING_ON);
    await drag(page, [1, 1], [12, 1]);
    await expect(selection(page).first()).toBeVisible();
    expect(await sentBytes(page)).toEqual([]);
    expect(await page.evaluate(() => window.terminalLab!.session.inputCalls)).toBe(0);
    await expect(badge(page)).toHaveCount(0);
  });

  test('with tracking off the pointer selects whatever the prop and capture say', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open({ query: { mouse: true } });
    await captureKeys(page);
    await resetSent(page);
    await drag(page, [1, 1], [12, 1]);
    await expect(selection(page).first()).toBeVisible();
    expect(await sentBytes(page)).toEqual([]);
  });
});

test.describe('reporting is permitted: the prop is on, capture is on, and the view is writable', () => {
  test('a press and release are reported as exact SGR bytes and nothing is selected', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open({ query: { mouse: true } });
    await write(page, TRACKING_ON);
    await captureKeys(page);
    await expect(badge(page)).toBeVisible();
    await expect(captureButton(page)).toHaveAccessibleDescription('Mouse reporting on');
    await resetSent(page);
    await drag(page, [3, 2], [9, 2]);
    expect(await sentBytes(page)).toEqual(bytes(`${ESC}[<0;3;2M${ESC}[<0;9;2m`));
    await expect(selection(page)).toHaveCount(0);
  });

  test('the indicator follows the program and capture, and each change is said once', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open({ query: { mouse: true } });
    await captureKeys(page);
    await expect(badge(page)).toHaveCount(0);
    await write(page, TRACKING_ON);
    await expect(badge(page)).toBeVisible();
    await write(page, `${ESC}[?1000l${ESC}[?1006l`);
    await expect(badge(page)).toHaveCount(0);
    await write(page, TRACKING_ON);
    await expect(badge(page)).toBeVisible();
    await page.keyboard.press('Control+Shift+Escape');
    await expect(badge(page)).toHaveCount(0);
    // Releasing capture is announced by capture's own message, not by a second mouse one: the
    // two on-announcements and the one off-announcement are the program's, and capture's are its.
    await expect.poll(() => announcedCount(page, 'Terminal key capture off')).toBe(1);
    expect(await announcedCount(page, 'Terminal key capture on')).toBe(1);
    expect(await announcedCount(page, 'Mouse reporting on')).toBe(2);
    expect(await announcedCount(page, 'Mouse reporting off')).toBe(1);
  });
});
