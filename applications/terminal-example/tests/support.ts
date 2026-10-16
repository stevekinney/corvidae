import { expect, type Locator, type Page } from '@playwright/test';

/** The rows the engine has drawn, as the text a reader would see. */
export function screen(page: Page, scope: Locator | Page = page): Locator {
  return scope.locator('.cinder-terminal__viewport .xterm-rows');
}

export function terminalInput(page: Page, scope: Locator | Page = page): Locator {
  return scope.locator('textarea.xterm-helper-textarea');
}

/** Wait until the session is attached and the terminal accepts keys. */
export async function connected(page: Page): Promise<void> {
  await expect(page.getByRole('status').filter({ hasText: 'Connected' }).first()).toBeVisible();
  await expect(terminalInput(page)).toBeAttached();
}

/** Type a line into the focused terminal and press Enter. */
export async function typeLine(page: Page, text: string): Promise<void> {
  await terminalInput(page).focus();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
}

/** Ask the shell for its process identifier and read it back from the screen. */
export async function shellPid(page: Page, marker: string): Promise<number> {
  await typeLine(page, `echo ${marker}=$$`);
  const pattern = new RegExp(`${marker}=(\\d+)`);
  await expect(screen(page)).toHaveText(pattern);
  const text = await screen(page).innerText();
  const match = pattern.exec(text);
  if (match === null) throw new Error('The shell did not print its process identifier.');
  return Number(match[1]);
}

/** Whether a process with this identifier still exists. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Record every Content-Security-Policy violation and uncaught page error the page reports. */
export async function recordViolations(page: Page): Promise<string[]> {
  const violations: string[] = [];
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      console.error(`csp-violation: ${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  page.on('console', (message) => {
    if (message.type() === 'error') violations.push(message.text());
  });
  page.on('pageerror', (error) => violations.push(error.message));
  return violations;
}
