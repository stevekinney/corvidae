/**
 * `/agents/:agent` by its tabs, against the real host: Chats (filtered by state, who started them
 * and a title search, each applied by the Bureau before it cuts a page), Instructions (the file's
 * body as a document, with Edit, and the reference documents), Access (the tools and when each asks first, the skills, guardrails and budgets; see
 * `agent-access.spec.ts`) and Settings (the model, Delete, and the saved versions with Restore). The tab is in the address.
 */
import type { APIRequestContext, Page } from '@playwright/test';

import { AGENT_PAGE_COPY } from '../../src/app/copy.ts';
import { bureau, createAgentFile, readAgent, removeAgent } from './agent-support.ts';
import { deleteChats, newThreadId, runToEnd } from './chat-support.ts';
import { expect, test } from './fixtures.ts';
import { TEXT_ECHO_AGENT_NAME } from './text-echo-agent.ts';

const WIDTHS = [375, 1280] as const;
const CHATS = AGENT_PAGE_COPY.chats;

const page_ = (page: Page) => page.locator('[data-page="agent-detail"]');

/** Agents and chats this file's specs create, removed after each spec. */
const agents = new Set<string>();
const threads: string[] = [];

test.afterEach(async ({ request }) => {
  for (const id of agents) await removeAgent(request, id);
  agents.clear();
  await deleteChats(threads.splice(0));
});

/** Starts a chat with the echo agent whose first message is `message`, and answers its thread. */
async function chat(request: APIRequestContext, message: string): Promise<string> {
  const threadId = newThreadId('agent-page');
  threads.push(threadId);
  await runToEnd(request, TEXT_ECHO_AGENT_NAME, threadId, message);
  return threadId;
}

test.describe('the Chats tab', () => {
  test('finds a chat beyond the first page by its title, and filters by state', async ({
    page,
    request,
  }) => {
    const label = crypto.randomUUID().slice(0, 8);
    // The oldest chat is the one searched for; 22 newer ones push it past the first page of 20.
    await chat(request, `needle-${label} the oldest`);
    for (let index = 0; index < 22; index += 1) await chat(request, `${label} filler ${index}`);

    await page.goto(`/agents/${TEXT_ECHO_AGENT_NAME}`);
    const list = page.getByRole('navigation', { name: 'Chats with this agent' });
    await expect(list.getByRole('button', { name: /filler/ }).first()).toBeVisible();
    await expect(list.getByRole('button', { name: new RegExp(`needle-${label}`) })).toHaveCount(0);

    const search = page.getByRole('searchbox', { name: CHATS.searchLabel });
    await search.fill(`needle-${label}`);
    await search.press('Enter');

    await expect(list.getByRole('button', { name: new RegExp(`needle-${label}`) })).toHaveCount(1);
    await expect(list.getByRole('button', { name: /filler/ })).toHaveCount(0);
    // The request carried the search, so the Bureau cut the page from matches.
    await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);

    // A chat that has ended is neither running nor waiting, so those states hold none of them.
    await page.getByRole('radio', { name: CHATS.states.running }).click();
    await expect(page.getByText(CHATS.filteredTitle)).toBeVisible();
    await page.getByRole('radio', { name: CHATS.states['needs-you'] }).click();
    await expect(page.getByText(CHATS.filteredTitle)).toBeVisible();
    await page.getByRole('button', { name: CHATS.clearFilters }).click();
    await expect(list.getByRole('button', { name: /filler/ }).first()).toBeVisible();
  });

  test('says a schedule started none of an agent’s chats', async ({ page, request }) => {
    await chat(request, 'started by a person');
    await page.goto(`/agents/${TEXT_ECHO_AGENT_NAME}`);

    await page.getByLabel(CHATS.startedByLabel).selectOption('schedule');

    await expect(page.getByText(CHATS.filteredTitle)).toBeVisible();
    await page.getByLabel(CHATS.startedByLabel).selectOption('chat');
    await expect(
      page
        .getByRole('navigation', { name: 'Chats with this agent' })
        .getByRole('button', { name: /started by a person/ }),
    ).toBeVisible();
  });

  test('says an agent with no chats has none, with New chat as the action', async ({
    page,
    request,
  }) => {
    const id = 'e2e-page-no-chats';
    agents.add(id);
    await createAgentFile(request, id);

    await page.goto(`/agents/${id}`);

    const empty = page_(page).locator('[data-cinder-kind="first-use"]');
    await expect(empty).toContainText(CHATS.emptyTitle);
    await expect(empty.getByRole('link', { name: 'New chat' })).toBeVisible();
  });
});

test.describe('the Instructions tab', () => {
  test('renders the body as a document, offers Edit, and says there are no reference documents', async ({
    page,
    request,
  }) => {
    const id = 'e2e-page-instructions';
    agents.add(id);
    await createAgentFile(request, id, { instructions: '# Be careful\n\nCite **every** source.' });

    await page.goto(`/agents/${id}?tab=instructions`);

    const body = page.getByTestId('agent-instructions-body');
    await expect(body.getByRole('heading', { name: 'Be careful' })).toBeVisible();
    await expect(body.locator('strong')).toHaveText('every');
    await expect(page.getByText(AGENT_PAGE_COPY.instructions.noReferencesTitle)).toBeVisible();
    await page.getByRole('main').getByRole('link', { name: 'Edit' }).last().click();
    await expect(page).toHaveURL(new RegExp(`/agents/${id}/edit$`));
  });

  test('keeps the tab in the address, and an unknown tab is Chats', async ({ page, request }) => {
    const id = 'e2e-page-tabs';
    agents.add(id);
    await createAgentFile(request, id);

    await page.goto(`/agents/${id}`);
    await page.getByRole('tab', { name: AGENT_PAGE_COPY.tabs.instructions }).click();
    await expect(page).toHaveURL(new RegExp(`/agents/${id}\\?tab=instructions$`));
    await page.getByRole('tab', { name: AGENT_PAGE_COPY.tabs.chats }).click();
    await expect(page).toHaveURL(new RegExp(`/agents/${id}$`));

    await page.goto(`/agents/${id}?tab=nonsense`);
    await expect(page).toHaveURL(new RegExp(`/agents/${id}$`));
    await expect(page.getByRole('tab', { name: AGENT_PAGE_COPY.tabs.chats })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
});

test.describe('the Settings tab', () => {
  test('restores an older version as a new version', async ({ page, request }) => {
    const id = 'e2e-page-versions';
    agents.add(id);
    const created = await createAgentFile(request, id, { instructions: 'First instructions.' });
    const before = await readAgent(request, id);
    const saved = await bureau(request, 'bureau.agents.definitions.update', {
      id,
      expectedHash: created.hash,
      definition: {
        ...before.definition,
        instructions: 'Second instructions.',
      },
    });
    expect(saved.fault).toBeUndefined();

    await page.goto(`/agents/${id}?tab=settings`);

    const versions = page.getByTestId('agent-versions');
    await expect(versions.locator('[data-revision]')).toHaveCount(2);
    await versions.getByRole('button', { name: 'Restore version 1' }).click();
    await expect(versions.locator('[data-revision]')).toHaveCount(3);
    const restored = await readAgent(request, id);
    expect(restored.definition?.instructions).toBe('First instructions.');
  });

  test('deletes the agent and returns to the list', async ({ page, request }) => {
    const id = 'e2e-page-delete';
    agents.add(id);
    await createAgentFile(request, id);

    await page.goto(`/agents/${id}?tab=settings`);
    await page.getByRole('button', { name: AGENT_PAGE_COPY.settings.deleteAction }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: AGENT_PAGE_COPY.settings.deleteDialog.confirm })
      .click();

    await expect(page).toHaveURL(/\/agents$/);
    const gone = await bureau(request, 'bureau.agents.definitions.get', { id });
    expect(gone.fault).toBeDefined();
  });
});

for (const width of WIDTHS) {
  test.describe(`at ${width} pixels`, () => {
    for (const tab of ['chats', 'instructions', 'access', 'settings'] as const) {
      test(`the ${tab} tab passes axe`, async ({ page, request, checkA11y }) => {
        await page.setViewportSize({ width, height: 900 });
        const id = 'e2e-page-axe';
        agents.add(id);
        await createAgentFile(request, id);
        await page.goto(`/agents/${id}${tab === 'chats' ? '' : `?tab=${tab}`}`);
        await expect(page.getByRole('tab', { name: AGENT_PAGE_COPY.tabs[tab] })).toHaveAttribute(
          'aria-selected',
          'true',
        );
        if (tab === 'settings') await expect(page.getByTestId('agent-versions')).toBeVisible();
        await checkA11y(`the ${tab} tab of an agent at ${width}px`);
      });
    }
  });
}
