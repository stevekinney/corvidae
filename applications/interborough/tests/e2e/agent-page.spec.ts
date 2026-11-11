/**
 * An agent's page by its tabs, against the real host: Chats (`/agents/:agent`, filtered by state,
 * who started them and a title search, each applied by the Bureau before it cuts a page),
 * Instructions (`/instructions`, the file's body as a document and the reference documents), Access
 * (`/access`, the tools and when each asks first, the skills, guardrails and budgets; see
 * `agent-access.spec.ts`), Memory (`/memory`, inside the same header and tab bar; see
 * `27-agent-memory.spec.ts`) and Settings (`/settings`, the model, Delete, and the saved versions
 * with Restore). Each tab is a path of its own; an address from before that (`?tab=`) is replaced
 * with the tab's path.
 */
import type { APIRequestContext, Page } from '@playwright/test';

import { AGENT_PAGE_COPY } from '../../src/app/copy.ts';
import { bureau, createAgentFile, readAgent, removeAgent } from './agent-support.ts';
import { deleteChats, newThreadId, runToEnd } from './chat-support.ts';
import { expect, test } from './fixtures.ts';
import { TEXT_ECHO_AGENT_NAME } from './text-echo-agent.ts';
import { expectTabOpen } from './workflow-support.ts';

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
    const list = page.getByTestId('agent-chats');
    await expect(list.getByRole('link', { name: /filler/ }).first()).toBeVisible();
    await expect(list.getByRole('link', { name: new RegExp(`needle-${label}`) })).toHaveCount(0);

    // The filter bar searches as it is typed in.
    const search = page.getByRole('searchbox', { name: CHATS.searchLabel });
    await search.fill(`needle-${label}`);

    await expect(list.getByRole('link', { name: new RegExp(`needle-${label}`) })).toHaveCount(1);
    await expect(list.getByRole('link', { name: /filler/ })).toHaveCount(0);
    // The request carried the search, so the Bureau cut the page from matches.
    await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);

    // A chat that has ended is neither running nor waiting, so those states hold none of them.
    await page.getByRole('radio', { name: new RegExp(`^${CHATS.states.running}`) }).click();
    await expect(page.getByText(CHATS.filteredTitle)).toBeVisible();
    await page.getByRole('radio', { name: new RegExp(`^${CHATS.states['needs-you']}`) }).click();
    await expect(page.getByText(CHATS.filteredTitle)).toBeVisible();
    await page.getByRole('button', { name: CHATS.clearFilters }).click();
    await expect(list.getByRole('link', { name: /filler/ }).first()).toBeVisible();
  });

  test('says a schedule started none of an agent’s chats', async ({ page, request }) => {
    await chat(request, 'started by a person');
    await page.goto(`/agents/${TEXT_ECHO_AGENT_NAME}`);

    const startedBy = page.getByRole('combobox', { name: CHATS.startedByLabel });
    await startedBy.click();
    await page.getByRole('option', { name: CHATS.startedBy.schedule }).click();

    await expect(page.getByText(CHATS.filteredTitle)).toBeVisible();
    await startedBy.click();
    await page.getByRole('option', { name: CHATS.startedBy.chat }).click();
    await expect(
      page.getByTestId('agent-chats').getByRole('link', { name: /started by a person/ }),
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
  test('renders the body as a document, leaves Edit to the header, and says there are no reference documents', async ({
    page,
    request,
  }) => {
    const id = 'e2e-page-instructions';
    agents.add(id);
    await createAgentFile(request, id, { instructions: '# Be careful\n\nCite **every** source.' });

    await page.goto(`/agents/${id}/instructions`);

    const body = page.getByTestId('agent-instructions-body');
    await expect(body.getByRole('heading', { name: 'Be careful' })).toBeVisible();
    await expect(body.locator('strong')).toHaveText('every');
    await expect(page.getByTestId('agent-no-references')).toContainText('None added.');
    // The header holds the one Edit; the tab links the editor in words of its own.
    await expect(
      page.getByRole('main').getByRole('link', { name: 'Edit', exact: true }),
    ).toHaveCount(1);
    await page.getByTestId('agent-header').getByRole('link', { name: 'Edit', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/agents/${id}/edit$`));
  });

  test('gives each tab its own path, which a reload keeps, and replaces an old ?tab= address', async ({
    page,
    request,
  }) => {
    const id = 'e2e-page-tabs';
    agents.add(id);
    await createAgentFile(request, id);

    await page.goto(`/agents/${id}`);
    await page.getByRole('tab', { name: AGENT_PAGE_COPY.tabs.instructions }).click();
    await expect(page).toHaveURL(new RegExp(`/agents/${id}/instructions$`));
    await page.reload();
    await expect(
      page.getByRole('tab', { name: AGENT_PAGE_COPY.tabs.instructions }),
    ).toHaveAttribute('aria-selected', 'true');
    // The breadcrumb names the tab under the agent.
    await expect(page.getByRole('navigation', { name: 'Breadcrumb' })).toContainText(
      AGENT_PAGE_COPY.tabs.instructions,
    );
    await page.getByRole('tab', { name: AGENT_PAGE_COPY.tabs.chats }).click();
    await expect(page).toHaveURL(new RegExp(`/agents/${id}$`));

    // Memory is a tab of the same page: the header and the tab bar stay above it.
    await page.getByRole('tab', { name: AGENT_PAGE_COPY.tabs.memory }).click();
    await expect(page).toHaveURL(new RegExp(`/agents/${id}/memory$`));
    await expect(page.getByTestId('agent-header')).toBeVisible();

    // An address from before each tab had a path opens the tab, not a missing page.
    await page.goto(`/agents/${id}?tab=access`);
    await expect(page).toHaveURL(new RegExp(`/agents/${id}/access$`));
    await expect(page.getByRole('tab', { name: AGENT_PAGE_COPY.tabs.access })).toHaveAttribute(
      'aria-selected',
      'true',
    );
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

    await page.goto(`/agents/${id}/settings`);

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

    await page.goto(`/agents/${id}/settings`);
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
    for (const tab of ['chats', 'instructions', 'access', 'memory', 'settings'] as const) {
      test(`the ${tab} tab passes axe`, async ({ page, request, checkA11y }) => {
        await page.setViewportSize({ width, height: 900 });
        const id = 'e2e-page-axe';
        agents.add(id);
        await createAgentFile(request, id);
        await page.goto(`/agents/${id}${tab === 'chats' ? '' : `/${tab}`}`);
        // At the phone width the tab bar is one select named Tab, and the open tab is its value.
        await expectTabOpen(page.locator('body'), AGENT_PAGE_COPY.tabs[tab]);
        if (tab === 'settings') await expect(page.getByTestId('agent-versions')).toBeVisible();
        await checkA11y(`the ${tab} tab of an agent at ${width}px`);
      });
    }
  });
}
