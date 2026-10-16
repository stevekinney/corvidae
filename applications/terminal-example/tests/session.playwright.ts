import { expect, test } from '@playwright/test';

import {
  connected,
  enroll,
  isAlive,
  recordViolations,
  screen,
  shellPid,
  typeLine,
} from './support.ts';

test('types into the login shell and sees the output', async ({ page }) => {
  const problems = await recordViolations(page);
  await enroll(page);
  await connected(page);
  await typeLine(page, 'echo answer-$((6 * 7))');
  await expect(screen(page)).toContainText('answer-42');
  // The socket connected and nothing was blocked under the Content-Security-Policy.
  expect(problems).toEqual([]);
});

test('resizes the process when the viewport changes', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await enroll(page);
  await connected(page);
  const readSize = async (marker: string): Promise<[number, number]> => {
    await typeLine(page, `echo ${marker}=$(stty size | tr ' ' x)`);
    const pattern = new RegExp(`${marker}=(\\d+)x(\\d+)`);
    await expect(screen(page)).toHaveText(pattern);
    const match = pattern.exec(await screen(page).innerText());
    if (match === null) throw new Error('stty printed no size.');
    return [Number(match[1]), Number(match[2])];
  };
  const [rowsBefore, columnsBefore] = await readSize('first');
  await page.setViewportSize({ width: 700, height: 900 });
  await expect
    .poll(
      async () => {
        const [, columns] = await readSize(`next${Date.now()}`);
        return columns;
      },
      { timeout: 15_000 },
    )
    .toBeLessThan(columnsBefore);
  expect(rowsBefore).toBeGreaterThan(0);
});

test('reloading starts a new session and ends the old process', async ({ page }) => {
  await enroll(page);
  await connected(page);
  const first = await shellPid(page, 'before');
  await page.reload();
  await connected(page);
  const second = await shellPid(page, 'after');
  expect(second).not.toBe(first);
  // Nothing was replayed into the new session, and the old shell is gone.
  await expect(screen(page)).not.toContainText('before=');
  await expect.poll(() => isAlive(first), { timeout: 15_000 }).toBe(false);
  expect(isAlive(second)).toBe(true);
});

test('no child process survives after the page closes', async ({ page }) => {
  await enroll(page);
  await connected(page);
  const shell = await shellPid(page, 'shell');
  // A foreground child that keeps running, which the shell would otherwise leave to the terminal.
  await typeLine(page, "sh -c 'echo child=$$; exec sleep 300'");
  await expect(screen(page)).toHaveText(/child=\d+/);
  const child = Number(/child=(\d+)/.exec(await screen(page).innerText())?.[1]);
  expect(isAlive(shell)).toBe(true);
  expect(isAlive(child)).toBe(true);
  await page.close();
  await expect.poll(() => isAlive(shell), { timeout: 15_000 }).toBe(false);
  await expect.poll(() => isAlive(child), { timeout: 15_000 }).toBe(false);
});
