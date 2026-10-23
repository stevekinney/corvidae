/**
 * Starting, listing, and returning to chat sessions: `/` opens the newest session, `/chat` lists
 * them with load-more paging, `/chat/new` starts one with the agent chosen above the composer and
 * becomes `/chat/:sessionId` without a reload, and a finished session opens on its whole
 * transcript. The page is the real application against the real host.
 */
import type { Page } from '@playwright/test';

import { VIEW_COPY } from '../../src/app/copy.ts';
import { newThreadId, runToEnd } from './chat-support.ts';
import { expect, test } from './fixtures.ts';

const composer = (page: Page) => page.getByRole('textbox');

async function send(page: Page, text: string): Promise<void> {
  await composer(page).fill(text);
  await composer(page).press('Enter');
}

const sessionUrl = /\/chat\/(?!new(?:$|\?))[^/?]+$/;

/** The session identifier the address names. */
function sessionOf(page: Page): string {
  return decodeURIComponent(new URL(page.url()).pathname.split('/').at(-1) ?? '');
}

/** Answers every `bureau.contexts.list` with no sessions, for a page that must see an empty Bureau. */
async function withNoSessions(page: Page): Promise<void> {
  await page.route('**/bureau/jsonrpc', async (route) => {
    if ((route.request().postData() ?? '').includes('"bureau.contexts.list"')) {
      await route.fulfill({
        json: {
          jsonrpc: '2.0',
          id: 'bureau.contexts.list',
          result: { contexts: [], nextOffset: null },
        },
      });
      return;
    }
    await route.fallback();
  });
}

test.describe('the home screen', () => {
  test('opens the session that was updated most recently', async ({ page, request }) => {
    await runToEnd(request, 'assistant', newThreadId('older'), 'An older chat');
    const newest = newThreadId('newest');
    await runToEnd(request, 'assistant', newest, 'The newest chat');

    await page.goto('/');

    await expect(page).toHaveURL(new RegExp(`/chat/${newest}$`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('The newest chat');
  });

  test('replaces its own history entry, so Back does not return to it', async ({
    page,
    request,
  }) => {
    await runToEnd(request, 'assistant', newThreadId('home'), 'Chat for the home screen');
    await page.goto('/agents');

    await page.goto('/');
    await expect(page).toHaveURL(sessionUrl);
    await page.goBack();

    await expect(page).toHaveURL(/\/agents$/);
  });

  test('lands on /chat when there is no session, and New chat there reaches a working /chat/new', async ({
    page,
  }) => {
    await withNoSessions(page);

    await page.goto('/');

    await expect(page).toHaveURL(/\/chat$/);
    await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'empty');
    await page.getByRole('link', { name: 'New chat' }).click();
    await expect(page).toHaveURL(/\/chat\/new$/);
    await send(page, 'The first message of a first chat');
    await expect(page).toHaveURL(sessionUrl);
    await expect(page.getByText('Hello from the assistant.')).toBeVisible();
  });
});

test.describe('the list of sessions', () => {
  test('is newest first, labelled with the agent, and pages with Load more', async ({
    page,
    request,
  }) => {
    const label = crypto.randomUUID().slice(0, 8);
    for (let index = 1; index <= 22; index += 1) {
      await runToEnd(
        request,
        'assistant',
        newThreadId('page'),
        `${label} chat ${String(index).padStart(2, '0')}`,
      );
    }

    await page.goto('/chat');

    const list = page.getByRole('navigation', { name: 'Chats' });
    const rows = list.getByRole('listitem');
    // The newest is first, and the row names the agent.
    await expect(rows.first()).toContainText(`${label} chat 22`);
    await expect(rows.first()).toContainText('assistant');
    // A page is twenty rows. The list loads the next page as the end comes into view, or when
    // Load more is pressed, so keep asking for it until the oldest of these chats is there.
    const oldest = list.getByRole('button', { name: new RegExp(`${label} chat 01`) });
    await expect(async () => {
      const more = list.getByRole('button', { name: 'Load more' });
      if (await more.isVisible()) await more.click();
      await expect(oldest).toBeVisible({ timeout: 1_000 });
    }).toPass();
    expect(await rows.count()).toBeGreaterThan(20);
  });

  test('opens the session a row names', async ({ page, request }) => {
    const threadId = newThreadId('row');
    await runToEnd(request, 'assistant', threadId, 'Open me from the list');
    await page.goto('/chat');

    await page
      .getByRole('navigation', { name: 'Chats' })
      .getByRole('button', { name: /Open me from the list/ })
      .click();

    await expect(page).toHaveURL(new RegExp(`/chat/${threadId}$`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Open me from the list');
  });
});

test.describe('a new chat', () => {
  test('talks to the default agent, which a searchable list changes before the first message', async ({
    page,
  }) => {
    await page.goto('/chat/new');
    const agent = page.getByRole('combobox', { name: 'Agent' });
    await expect(agent).toHaveValue(/assistant/i);

    await agent.fill('tool');
    await page.getByRole('option', { name: /tool-runner/i }).click();

    await expect(page).toHaveURL(/\/chat\/new\?agent=tool-runner$/);
    await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
  });

  test('starts from ?agent=, becomes /chat/:sessionId without a reload, and fixes the agent', async ({
    page,
  }) => {
    await page.goto('/chat/new?agent=tool-runner');
    await expect(page.getByRole('combobox', { name: 'Agent' })).toHaveValue('tool-runner');
    // A reload would discard this.
    await page.evaluate(() => {
      Reflect.set(window, '__stillHere', true);
    });

    await send(page, 'Refund order-1001');

    await expect(page).toHaveURL(sessionUrl);
    await expect(page.locator('.ib-decision')).toBeVisible();
    expect(await page.evaluate(() => Reflect.get(window, '__stillHere'))).toBe(true);
    await expect(page.getByRole('combobox', { name: 'Agent' })).toHaveCount(0);
    await expect(page.getByText('tool-runner', { exact: true })).toHaveCount(1);
  });

  test('replaces its history entry when it starts, so Back returns to where the person came from', async ({
    page,
  }) => {
    await page.goto('/agents');
    await page.goto('/chat/new');

    await send(page, 'A chat for the back button');
    await expect(page).toHaveURL(sessionUrl);
    await page.goBack();

    await expect(page).toHaveURL(/\/agents$/);
  });

  test('is not found for an agent that does not exist, and for one that is not published', async ({
    page,
  }) => {
    for (const agent of ['no-such-agent', 'internal']) {
      await page.goto(`/chat/new?agent=${agent}`);
      const frame = page.locator('[data-view="chat"]');
      await expect(frame).toHaveAttribute('data-state', 'not-found');
      // It is the agent that is missing, so the page says so and not that a conversation is.
      await expect(frame.getByRole('heading', { level: 1 })).toHaveText(
        VIEW_COPY.chat.notFoundByPattern?.['/chat/new']?.title ?? '',
      );
    }
  });

  test('stays on /chat/new with the row failed and a retry when the first run is refused', async ({
    page,
  }) => {
    let refuse = true;
    await page.route('**/ag-ui/agents/assistant/run', async (route) => {
      if (!refuse) {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: `data: ${JSON.stringify({ type: 'RUN_ERROR', message: 'The thread is busy.', code: 'THREAD_BUSY' })}\n\n`,
      });
    });
    await page.goto('/chat/new');

    await send(page, 'A first message that is refused');

    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(page).toHaveURL(/\/chat\/new$/);
    refuse = false;
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page).toHaveURL(sessionUrl);
    await expect(page.getByText('Hello from the assistant.')).toBeVisible();
  });
});

test.describe('returning to a session', () => {
  test('a second chat with the same agent does not replace the first: it opens with its own identifier and title', async ({
    page,
  }) => {
    const label = crypto.randomUUID().slice(0, 8);
    await page.goto('/chat/new?agent=assistant');
    await send(page, `${label} first topic`);
    await expect(page).toHaveURL(sessionUrl);
    const first = sessionOf(page);
    await expect(page.getByText('Hello from the assistant.')).toBeVisible();

    await page.goto('/chat/new?agent=assistant');
    await send(page, `${label} second topic`);
    await expect(page).toHaveURL(sessionUrl);
    const second = sessionOf(page);
    await expect(page.getByText('Hello from the assistant.')).toBeVisible();
    expect(second).not.toBe(first);

    await page.goto('/chat');
    await page
      .getByRole('navigation', { name: 'Chats' })
      .getByRole('button', { name: new RegExp(`${label} first topic`) })
      .click();

    expect(sessionOf(page)).toBe(first);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${label} first topic`);
  });

  /**
   * A new chat taken through two questions, so its transcript has a first and a second turn. The
   * first question is unique to the session, so a list of every session names this one alone.
   */
  async function finishedSession(page: Page): Promise<{ address: string; first: string }> {
    const first = `Question one ${crypto.randomUUID().slice(0, 8)}`;
    await page.goto('/chat/new');
    await send(page, first);
    await expect(page).toHaveURL(sessionUrl);
    await expect(page.getByText('Hello from the assistant.')).toHaveCount(1);
    await send(page, 'Question two');
    await expect(page.getByText('Hello from the assistant.')).toHaveCount(2);
    return { address: page.url(), first };
  }

  /** That the transcript on screen is the whole thread, in the order it happened. */
  async function expectWholeTranscript(page: Page, first: string): Promise<void> {
    await expect(page.getByRole('log').getByText(first)).toBeVisible();
    await expect(page.getByText('Hello from the assistant.')).toHaveCount(2);
    const content = (await page.locator('[data-session]').textContent()) ?? '';
    const positions = [first, 'Hello from the assistant.', 'Question two'].map((text) =>
      content.indexOf(text),
    );
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual(positions.toSorted((left, right) => left - right));
    expect(content.lastIndexOf('Hello from the assistant.')).toBeGreaterThan(
      content.indexOf('Question two'),
    );
  }

  test('a finished session opens on its whole transcript, in order, after a reload and after navigating away and back', async ({
    page,
  }) => {
    const { address, first } = await finishedSession(page);

    await page.reload();
    await expectWholeTranscript(page, first);

    await page.goto('/runs');
    await page.goto(address);
    await expectWholeTranscript(page, first);
  });

  test('a finished session opens on its whole transcript when the person leaves it inside the app and comes back', async ({
    page,
  }) => {
    const { address, first } = await finishedSession(page);

    // A link and Back, and a list row: no reload, so nothing of the page is carried but the app.
    await page.getByRole('link', { name: 'Agents', exact: true }).click();
    await expect(page).toHaveURL(/\/agents$/);
    await page.goBack();
    await expect(page).toHaveURL(address);
    await expectWholeTranscript(page, first);

    await page.getByRole('link', { name: 'Agents', exact: true }).click();
    await expect(page).toHaveURL(/\/agents$/);
    await page.getByRole('link', { name: 'Chat', exact: true }).first().click();
    await page.getByRole('button', { name: new RegExp(first) }).click();
    await expect(page).toHaveURL(address);
    await expectWholeTranscript(page, first);
  });
});
