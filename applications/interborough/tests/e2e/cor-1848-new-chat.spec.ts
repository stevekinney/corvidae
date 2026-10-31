/**
 * New chat and the chat list (COR-1848): a new chat is built around the composer (a greeting, the
 * agent's example prompts, the other agents as one row, the agent chosen from a pill inside the
 * composer and no agent list in the header), the chat list sits beside the open chat with the
 * chats that need the person first, and C starts a new chat from anywhere. The page is the real
 * application against the real host.
 */
import type { Page } from '@playwright/test';

import { newThreadId, runToEnd } from './chat-support.ts';
import { expect, test } from './fixtures.ts';

const composer = (page: Page) => page.getByRole('textbox');
const transcript = (page: Page) => page.getByRole('region', { name: 'Chat conversation' });

test.describe('a new chat', () => {
  test('is built around the composer: the agent pill is in the composer, and the header holds no agent list', async ({
    page,
  }) => {
    await page.goto('/chats/new');

    const pill = page.getByRole('combobox', { name: 'Agent' });
    await expect(pill).toBeVisible();
    await expect(pill).toHaveValue(/assistant/i);
    // The pill is inside the composer's own region, and not in the header above it.
    expect(await pill.evaluate((element) => element.closest('header') === null)).toBe(true);
    const composerBox = await composer(page).boundingBox();
    const pillBox = await pill.boundingBox();
    expect(pillBox?.y ?? 0).toBeGreaterThan(composerBox?.y ?? 0);
    // One agent control, no agent card, no second title.
    await expect(page.getByRole('combobox', { name: 'Agent' })).toHaveCount(1);
    await expect(page.getByTestId('agent-card')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    await expect(page.getByTestId('new-chat-welcome').getByRole('heading')).toHaveCount(0);
  });

  test('lists itself as the first row, and becomes the chat without a reload', async ({ page }) => {
    await page.goto('/chats/new');
    const list = page.getByRole('region', { name: 'Chats' });
    const draft = list.locator('[data-group="draft"]');
    await expect(draft).toHaveCount(1);
    await expect(draft).toContainText('New chat');
    await expect(draft).toHaveAttribute('aria-current', 'true');
    await page.evaluate(() => {
      Reflect.set(window, '__stillHere', true);
    });

    await composer(page).fill('Hello from the new chat');
    await composer(page).press('Enter');

    await expect(page).toHaveURL(/\/chats\/(?!new(?:$|\?))[^/?]+$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hello from the new chat');
    expect(await page.evaluate(() => Reflect.get(window, '__stillHere'))).toBe(true);
    // The Bureau lists the chat now, and the list marks it as the open one.
    await expect(list.locator('[data-group="draft"]')).toHaveCount(0);
    await expect(list.locator('[aria-current="true"]')).toContainText('Hello from the new chat');
  });

  test('gives a fresh chat to the C shortcut and to New chat straight after one started', async ({
    page,
  }) => {
    await page.goto('/chats/new');
    await composer(page).fill('The first chat');
    await composer(page).press('Enter');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('The first chat');
    const firstAddress = page.url();

    // C from outside a field, then New chat.
    await page.getByRole('heading', { level: 1 }).click();
    await page.keyboard.press('c');
    await expect(page).toHaveURL(/\/chats\/new$/);
    await expect(page.getByTestId('new-chat-welcome')).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('The first chat');
    await composer(page).fill('The second chat');
    await composer(page).press('Enter');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('The second chat');
    expect(page.url()).not.toBe(firstAddress);
    await expect(transcript(page)).not.toContainText('The first chat');

    await page
      .getByRole('region', { name: 'Chats' })
      .getByRole('link', { name: 'New chat' })
      .first()
      .click();
    await expect(page).toHaveURL(/\/chats\/new$/);
    await expect(page.getByTestId('new-chat-welcome')).toBeVisible();
    await composer(page).fill('The third chat');
    await composer(page).press('Enter');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('The third chat');
    await expect(transcript(page)).not.toContainText('The second chat');
  });

  test('keeps the transcript and the agent when the window crosses the list line', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/chats/new?agent=assistant');
    await composer(page).fill('A chat to resize');
    await composer(page).press('Enter');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('A chat to resize');
    const address = page.url();

    await page.setViewportSize({ width: 600, height: 800 });
    await expect(page.getByRole('region', { name: 'Chats' })).toHaveCount(0);
    await expect(transcript(page)).toContainText('A chat to resize');
    await expect(page.locator('.weft-chat-header__agent')).toHaveText('assistant');

    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.getByRole('region', { name: 'Chats' })).toBeVisible();
    await expect(transcript(page)).toContainText('A chat to resize');
    await expect(page.locator('.weft-chat-header__agent')).toHaveText('assistant');
    expect(page.url()).toBe(address);
    await expect(page.getByTestId('new-chat-welcome')).toHaveCount(0);
  });
});

test.describe('the chat list beside the open chat', () => {
  test('puts a chat that needs you first and keeps the open chat beside it', async ({
    page,
    request,
  }) => {
    const waiting = newThreadId('cor-1848-waiting');
    const finished = newThreadId('cor-1848-finished');
    await runToEnd(request, 'request-human-input', waiting, 'A chat that asks me a question');
    await runToEnd(request, 'assistant', finished, 'A chat that finished');
    await page.setViewportSize({ width: 1280, height: 900 });

    await page.goto(`/chats/${finished}`);

    const list = page.getByRole('region', { name: 'Chats' });
    await expect(list.locator('[data-chat]').first()).toHaveAttribute('data-group', 'needs-you');
    await expect(list.locator(`[data-chat="${waiting}"]`)).toContainText('Needs you');
    // Both panes are on screen: the list, and the conversation of the chat named by the address.
    await expect(list.locator(`[data-chat="${finished}"]`)).toHaveAttribute('aria-current', 'true');
    await expect(page.getByRole('region', { name: 'Open chat' })).toContainText(
      'A chat that finished',
    );

    await list.locator(`[data-chat="${waiting}"]`).click();

    await expect(page).toHaveURL(new RegExp(`/chats/${waiting}$`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'A chat that asks me a question',
    );
    await expect(list.locator(`[data-chat="${finished}"]`)).toBeVisible();
  });

  test('shows one pane at a time on a phone, with Back to the list', async ({ page, request }) => {
    const thread = newThreadId('cor-1848-phone');
    await runToEnd(request, 'assistant', thread, 'A chat on a phone');
    await page.setViewportSize({ width: 375, height: 800 });

    await page.goto(`/chats/${thread}`);

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('A chat on a phone');
    await expect(page.getByRole('region', { name: 'Chats' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Back' }).click();

    await expect(page).toHaveURL(/\/chats$/);
    await expect(page.getByRole('region', { name: 'Chats' })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
});

test.describe('the C shortcut', () => {
  test('starts a new chat from any page, and leaves a C typed into a field alone', async ({
    page,
  }) => {
    await page.goto('/agents');
    await expect(page.getByRole('heading', { level: 1, name: 'Agents' })).toBeVisible();
    await page.keyboard.press('c');
    await expect(page).toHaveURL(/\/chats\/new$/);

    await composer(page).pressSequentially('c');
    await expect(composer(page)).toHaveValue('c');
    await expect(page).toHaveURL(/\/chats\/new$/);
  });

  test('is listed in the shortcut map', async ({ page }) => {
    await page.goto('/agents');
    await expect(page.getByRole('heading', { level: 1, name: 'Agents' })).toBeVisible();
    await page.keyboard.press('?');

    const map = page.getByRole('dialog');
    await expect(map).toContainText('New chat');
  });
});
