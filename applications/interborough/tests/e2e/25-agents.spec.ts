/**
 * `/agents` and `/agents/:id`: the agents the Bureau tells the caller of, where each is defined and
 * whether it is published, a New chat action for a published one, and the chats had with one agent.
 */
import type { Page } from '@playwright/test';

import { VIEW_COPY } from '../../src/app/copy.ts';
import { newThreadId, runToEnd } from './chat-support.ts';
import { expect, test } from './fixtures.ts';

const WIDTHS = [375, 1280] as const;

const row = (page: Page, agent: string) => page.locator(`[data-agent="${agent}"]`);

test.describe('the list of agents', () => {
  test('shows each agent’s kind and publish state, and offers New chat only for a published one', async ({
    page,
  }) => {
    await page.goto('/agents');

    await expect(page.locator('[data-view="agents"]')).toHaveAttribute('data-state', 'ready');
    await expect(row(page, 'assistant')).toContainText('Defined in code');
    await expect(row(page, 'assistant')).toContainText('Published');
    await expect(row(page, 'assistant').getByRole('link', { name: 'New chat' })).toBeVisible();
    // The unpublished agent is listed to the one local caller, with its label and no chat action.
    await expect(row(page, 'internal')).toContainText('Not published');
    await expect(row(page, 'internal').getByRole('link', { name: 'New chat' })).toHaveCount(0);
  });

  test('New chat opens a working new chat with that agent', async ({ page }) => {
    await page.goto('/agents');

    await row(page, 'tool-runner').getByRole('link', { name: 'New chat' }).click();

    await expect(page).toHaveURL(/\/chat\/new\?agent=tool-runner$/);
    await expect(page.getByRole('combobox', { name: 'Agent' })).toHaveValue(/tool-runner/i);
  });
});

test.describe('one agent', () => {
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
