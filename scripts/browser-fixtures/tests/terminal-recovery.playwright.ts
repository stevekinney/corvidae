import type { Page } from '@playwright/test';

import {
  captureButton,
  captureKeys,
  expect,
  focusTerminal,
  frames,
  test,
  write,
} from './terminal-support.ts';

const group = (page: Page) => page.getByRole('group', { name: 'Terminal recovery' });

async function recoveryLabels(page: Page): Promise<string[]> {
  const labels = await group(page)
    .getByRole('button')
    .evaluateAll((buttons) => buttons.map((button) => button.textContent?.trim() ?? ''));
  return labels;
}

const openState = (
  terminalPage: Parameters<Parameters<typeof test>[2]>[0]['terminalPage'],
  state: string,
  query: Record<string, string | number | boolean> = {},
) => terminalPage.open({ query: { state, actions: true, quiet: true, ...query } });

test.describe('each state offers the actions its row of the state table names', () => {
  const TABLE: Array<[string, string[]]> = [
    ['empty', ['New session']],
    ['loading', ['Cancel']],
    ['connecting', ['Cancel']],
    ['exited', ['New session']],
    ['disconnected', ['New session']],
    ['denied', ['Try again', 'New session']],
    ['failed', ['Retry']],
    ['cleanup-incomplete', ['Check cleanup']],
    ['writable', []],
    ['read-only', []],
    ['backpressured', []],
  ];

  for (const [state, expected] of TABLE) {
    test(`${state} offers ${expected.length === 0 ? 'no action' : expected.join(' and ')}`, async ({
      terminalPage,
    }) => {
      const page = await openState(terminalPage, state);
      expect(await recoveryLabels(page)).toEqual(expected);
    });
  }

  test('an action without a host handler is not rendered', async ({ terminalPage }) => {
    const page = await terminalPage.open({ query: { state: 'denied', quiet: true } });
    await expect(group(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(0);
  });

  test('every state the engine mounts still keeps its output tools next to the actions', async ({
    terminalPage,
  }) => {
    const page = await openState(terminalPage, 'exited');
    await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New session' })).toBeVisible();
  });
});

test.describe('using an action', () => {
  test('a click and the keyboard each activate it once, and the handler is the host’s', async ({
    terminalPage,
  }) => {
    const page = await openState(terminalPage, 'denied');
    await page.getByRole('button', { name: 'Try again' }).click();
    await page.getByRole('button', { name: 'New session' }).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    expect(await page.evaluate(() => window.terminalLab!.events.actions)).toEqual([
      'Try again',
      'New session',
      'New session',
    ]);
    // The component changed nothing itself: the host owns the state.
    await expect(page.getByText('Access denied').first()).toBeVisible();
  });

  test('replacement waits for cleanup: the buttons show disabled and do nothing', async ({
    terminalPage,
  }) => {
    const page = await openState(terminalPage, 'exited', { cleanup: true });
    const replace = page.getByRole('button', { name: 'New session' });
    await expect(replace).toBeDisabled();
    await replace.click({ force: true });
    expect(await page.evaluate(() => window.terminalLab!.events.actions)).toEqual([]);
    await page.evaluate(() => window.terminalLab!.setProps({ cleanupPending: false }));
    await expect(replace).toBeEnabled();
    await replace.click();
    expect(await page.evaluate(() => window.terminalLab!.events.actions)).toEqual(['New session']);
  });

  test('cleanup-incomplete offers only the cleanup check, and no replacement or input', async ({
    terminalPage,
  }) => {
    const page = await openState(terminalPage, 'cleanup-incomplete', { cleanup: true });
    expect(await recoveryLabels(page)).toEqual(['Check cleanup']);
    await expect(page.getByRole('button', { name: 'Check cleanup' })).toBeEnabled();
    await page.getByRole('button', { name: 'Check cleanup' }).click();
    await expect(page.getByRole('button', { name: 'Check cleanup' })).toBeFocused();
    await page.keyboard.type('nothing');
    expect(await page.evaluate(() => window.terminalLab!.session.inputCalls)).toBe(0);
  });
});

test.describe('focus follows the action', () => {
  test('New session then Cancel hand focus to the button the new state offers', async ({
    terminalPage,
  }) => {
    const page = await openState(terminalPage, 'empty', { flow: true });
    await page.getByRole('button', { name: 'New session' }).click();
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('button', { name: 'New session' })).toBeFocused();
    expect(await page.evaluate(() => window.terminalLab!.events.actions)).toEqual([
      'New session',
      'Cancel',
    ]);
  });

  test('a failure keeps focus in the error action group, and output never moves it', async ({
    terminalPage,
  }) => {
    const page = await openState(terminalPage, 'failed');
    const retry = page.getByRole('button', { name: 'Retry' });
    await retry.click();
    await expect(retry).toBeFocused();
    await write(page, 'late output\r\n');
    await frames(page);
    await expect(retry, 'arriving output does not move focus').toBeFocused();
  });

  test('a button that survives the change keeps focus on every browser, even where a click does not focus it', async ({
    terminalPage,
  }) => {
    const page = await openState(terminalPage, 'cleanup-incomplete', { cleanup: true });
    await page.getByRole('button', { name: 'Check cleanup' }).click();
    await expect(page.getByRole('button', { name: 'Check cleanup' })).toBeFocused();
  });
});

test.describe('the actions are usable at the narrowest viewport', () => {
  test('every recovery button is inside the frame and reachable', async ({ terminalPage }) => {
    const page = await terminalPage.open({
      viewport: 'mobile',
      query: { state: 'denied', actions: true, quiet: true },
    });
    const inside = await page.evaluate(() => {
      const frame = document.querySelector('.cinder-terminal-frame')!.getBoundingClientRect();
      return [...document.querySelectorAll('.cinder-terminal__recovery button')].every((button) => {
        const box = button.getBoundingClientRect();
        return box.left >= frame.left - 0.5 && box.right <= frame.right + 0.5 && box.width > 0;
      });
    });
    expect(inside).toBe(true);
  });
});

test.describe('capture is visible on its control', () => {
  test('the pressed capture button looks different from the resting one', async ({
    terminalPage,
  }) => {
    const page = await terminalPage.open({ query: { quiet: true } });
    const face = () =>
      captureButton(page).evaluate((button) => {
        const style = getComputedStyle(button);
        return { background: style.backgroundColor, color: style.color };
      });
    const resting = await face();
    await captureKeys(page);
    // The pointer is still over the button, which would show its hover face.
    await page.mouse.move(0, 0);
    const pressed = await face();
    expect(pressed.background).not.toBe(resting.background);
    expect(pressed.color).not.toBe(resting.color);
    // It is the accent face Cinder gives a pressed toggle.
    const accent = await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.backgroundColor = 'var(--cinder-accent-solid)';
      document.body.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    });
    expect(pressed.background).toBe(accent);
    await page.keyboard.press('Control+Shift+Escape');
    await expect(captureButton(page)).toHaveAttribute('aria-pressed', 'false');
    expect(await face()).toEqual(resting);
    await focusTerminal(page);
  });
});
