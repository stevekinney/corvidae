/**
 * `/agents` and `/agents/:id`: the agents the Bureau tells the caller of, each with what it is made
 * of (its model or "Scripted", its tools), how much it has been used, the one badge an agent can
 * carry ("Not published"), a New chat action for a published one, and the chats had with one agent.
 */
import type { Page } from '@playwright/test';

import { VIEW_COPY } from '../../src/app/copy.ts';
import { newThreadId, runToEnd } from './chat-support.ts';
import { expect, test } from './fixtures.ts';
import { TEXT_ECHO_SOLO_AGENT_NAME } from './text-echo-agent.ts';

const WIDTHS = [375, 1280] as const;

const row = (page: Page, agent: string) => page.locator(`[data-agent="${agent}"]`);
const chatCount = (page: Page, agent: string) => row(page, agent).getByTestId('agent-chat-count');

/** How many chats the list says an agent has had: "No chats yet" is none. */
async function chatsOf(page: Page, agent: string): Promise<number> {
  const text = (await chatCount(page, agent).textContent()) ?? '';
  return Number.parseInt(/^(\d+) chats?$/.exec(text)?.[1] ?? '0', 10);
}

test.describe('the list of agents', () => {
  test('shows each agent’s model and tools, badges only one that is not published, and offers New chat only for a published one', async ({
    page,
  }) => {
    await page.goto('/agents');

    const frame = page.locator('[data-view="agents"]');
    await expect(frame).toHaveAttribute('data-state', 'ready');
    // Where an agent is defined is for the developer, and published is the normal state: neither is said.
    await expect(frame).not.toContainText('Defined in');
    await expect(frame).not.toContainText('Published');
    await expect(row(page, 'assistant')).toContainText('Scripted');
    await expect(row(page, 'assistant').getByRole('link', { name: 'New chat' })).toBeVisible();
    await expect(row(page, 'assistant').getByRole('link', { name: 'Memory' })).toBeVisible();
    // The unpublished agent is listed to the one local caller, with its badge and no chat action.
    await expect(row(page, 'internal')).toContainText('Not published');
    await expect(row(page, 'internal').getByRole('link', { name: 'New chat' })).toHaveCount(0);
    await expect(page.getByTestId('agent-not-published')).toHaveCount(1);
  });

  test('says what the Not published badge costs, to a keyboard as well as a pointer', async ({
    page,
  }) => {
    await page.goto('/agents');

    await row(page, 'internal').getByTestId('agent-not-published').focus();

    await expect(page.getByRole('tooltip')).toHaveText(/no one can start a chat/);
  });

  test('counts each agent’s chats and dates the last, and shows a chat had since on the next visit', async ({
    page,
    request,
  }) => {
    await page.goto('/agents');
    await expect(row(page, TEXT_ECHO_SOLO_AGENT_NAME)).toBeVisible();
    const before = await chatsOf(page, TEXT_ECHO_SOLO_AGENT_NAME);

    await runToEnd(request, TEXT_ECHO_SOLO_AGENT_NAME, newThreadId('usage'), 'A chat for the list');
    await page.goto('/agents');

    await expect(chatCount(page, TEXT_ECHO_SOLO_AGENT_NAME)).toHaveText(
      `${before + 1} ${before + 1 === 1 ? 'chat' : 'chats'}`,
    );
    await expect(row(page, TEXT_ECHO_SOLO_AGENT_NAME).getByTestId('agent-last-chat')).toHaveText(
      /^Last chat (just now|\d+[smhd] ago)$/,
    );
    // An agent nobody has chatted with says so, and has no last chat to date.
    await expect(chatCount(page, 'internal')).toHaveText('No chats yet');
    await expect(row(page, 'internal').getByTestId('agent-last-chat')).toHaveCount(0);
  });

  test('opens an agent’s memory from its row', async ({ page }) => {
    await page.goto('/agents');

    await row(page, 'tool-runner').getByRole('link', { name: 'Memory' }).click();

    await expect(page).toHaveURL(/\/agents\/tool-runner\/memory$/);
  });

  test('New chat opens a working new chat with that agent', async ({ page }) => {
    await page.goto('/agents');

    await row(page, 'tool-runner').getByRole('link', { name: 'New chat' }).click();

    await expect(page).toHaveURL(/\/chat\/new\?agent=tool-runner$/);
    await expect(page.getByRole('combobox', { name: 'Agent' })).toHaveValue(/tool-runner/i);
  });
});

test.describe('one agent', () => {
  test('shows its name once, its model, and a memory count that opens its memory', async ({
    page,
    request,
  }) => {
    await runToEnd(
      request,
      TEXT_ECHO_SOLO_AGENT_NAME,
      newThreadId('page'),
      'A memory for the page',
    );

    await page.goto(`/agents/${TEXT_ECHO_SOLO_AGENT_NAME}`);

    const frame = page.locator('[data-view="agents"]');
    await expect(frame.getByRole('heading', { level: 1 })).toHaveText(TEXT_ECHO_SOLO_AGENT_NAME);
    // The name is the heading and appears nowhere else in the header: no subtitle repeats it.
    await expect(
      page.locator('.ib-agent__header').getByText(TEXT_ECHO_SOLO_AGENT_NAME, { exact: true }),
    ).toHaveCount(1);
    await expect(frame).toContainText('Scripted');
    await expect(frame).not.toContainText('Defined in');
    await expect(frame).not.toContainText('Published');
    await expect(frame).not.toContainText('Revision');
    const memory = frame.getByRole('link', { name: /^Memory \(\d+\+?\)$/ });
    await expect(memory).toHaveCount(1);
    await memory.click();
    await expect(page).toHaveURL(new RegExp(`/agents/${TEXT_ECHO_SOLO_AGENT_NAME}/memory$`));
  });

  test('lists the chats had with it, and no other agent’s, and New chat opens a new chat with it', async ({
    page,
    request,
  }) => {
    const label = crypto.randomUUID().slice(0, 8);
    await runToEnd(request, 'tool-runner', newThreadId('mine'), `${label} refund for the runner`);
    await runToEnd(request, 'assistant', newThreadId('theirs'), `${label} hello for the assistant`);

    await page.goto('/agents/tool-runner');

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('tool-runner');
    const chats = page.getByRole('navigation', { name: 'Chats with this agent' });
    await expect(chats.getByRole('button', { name: new RegExp(label) })).toHaveCount(1);
    await expect(chats).toContainText('refund for the runner');
    await expect(chats).not.toContainText('hello for the assistant');
    await page.getByRole('link', { name: 'New chat' }).first().click();
    await expect(page).toHaveURL(/\/chat\/new\?agent=tool-runner$/);
  });

  test('opens a chat from its list', async ({ page, request }) => {
    const threadId = newThreadId('open');
    await runToEnd(request, 'tool-runner', threadId, 'Open this one from the agent page');
    await page.goto('/agents/tool-runner');

    await page
      .getByRole('navigation', { name: 'Chats with this agent' })
      .getByRole('button', { name: /Open this one from the agent page/ })
      .click();

    await expect(page).toHaveURL(new RegExp(`/chat/${threadId}$`));
  });

  test('says an agent that is not published is not, and offers no chat with it', async ({
    page,
  }) => {
    await page.goto('/agents/internal');

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('internal');
    await expect(page.getByText('Not published').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'New chat' })).toHaveCount(0);
  });

  test('is not found for an identifier the Bureau does not list', async ({ page }) => {
    await page.goto('/agents/nobody');

    const frame = page.locator('[data-view="agents"]');
    await expect(frame).toHaveAttribute('data-state', 'not-found');
    await expect(frame.getByRole('heading', { level: 1 })).toHaveText(
      VIEW_COPY.agents.notFound?.title ?? '',
    );
  });
});

for (const width of WIDTHS) {
  test.describe(`at ${width} pixels`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
    });

    test('the list of agents passes axe, with a chat count, a model, and the Not published badge', async ({
      page,
      request,
      checkA11y,
    }) => {
      await runToEnd(request, 'tool-runner', newThreadId('listaxe'), 'A chat for the agents list');
      await page.goto('/agents');
      await expect(page.locator('[data-view="agents"]')).toHaveAttribute('data-state', 'ready');
      await expect(chatCount(page, 'tool-runner')).toHaveText(/^\d+ chats?$/);
      await expect(page.getByTestId('agent-not-published')).toHaveCount(1);
      await checkA11y(`the list of agents at ${width}px`);
      // No row makes the page scroll sideways.
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
    });

    test('an agent’s page passes axe', async ({ page, request, checkA11y }) => {
      await runToEnd(request, 'tool-runner', newThreadId('axe'), 'A chat for the agent page');
      await page.goto('/agents/tool-runner');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('tool-runner');
      await checkA11y(`an agent's page at ${width}px`);
    });

    test('an unpublished agent’s page passes axe', async ({ page, checkA11y }) => {
      await page.goto('/agents/internal');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('internal');
      await checkA11y(`an unpublished agent's page at ${width}px`);
    });

    test('a missing agent is not found, and passes axe', async ({ page, checkA11y }) => {
      await page.goto('/agents/nobody');
      await expect(page.locator('[data-view="agents"]')).toHaveAttribute('data-state', 'not-found');
      await checkA11y(`a missing agent at ${width}px`);
    });

    test('a new chat passes axe, and so does an unknown agent’s', async ({ page, checkA11y }) => {
      await page.goto('/chat/new');
      await expect(page.getByRole('combobox', { name: 'Agent' })).toBeVisible();
      await checkA11y(`a new chat at ${width}px`);

      await page.goto('/chat/new?agent=no-such-agent');
      await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'not-found');
      await checkA11y(`a new chat with an unknown agent at ${width}px`);
    });

    test('the list of chats passes axe', async ({ page, request, checkA11y }) => {
      await runToEnd(request, 'assistant', newThreadId('listaxe'), 'A chat for the list');
      await page.goto('/chat');
      await expect(page.getByRole('navigation', { name: 'Chats' })).toBeVisible();
      await checkA11y(`the list of chats at ${width}px`);
    });
  });
}
