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

import { AGENT_PAGE_COPY } from '../../src/app/copy/agents.ts';
import { bureau, createAgentFile, readAgent, removeAgent } from './agent-support.ts';
import { deleteChats, newThreadId, runToEnd } from './chat-support.ts';
import { captureForDesignReview } from './design-review-capture.ts';
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

test('/agents/:agent/access: at 375px the Access tab is one collapsed Tab: Access select, not a visible tab bar', async ({
  page,
  request,
}) => {
  const id = 'e2e-page-access-collapse';
  agents.add(id);
  await createAgentFile(request, id);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/agents/${id}/access`);

  const tabs = page.locator('.cinder-tabs');
  await expect(tabs).toHaveAttribute('data-cinder-collapsed', '');
  await expect(tabs.locator('.cinder-select')).toContainText(/Tab:\s*Access/);
  await expect(tabs.getByRole('tablist')).toBeHidden();
  await captureForDesignReview(page, {
    route: '/agents/:agent/access',
    state: '375px collapsed Access tab',
    source: 'agent-page.spec.ts',
  });
});

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

test.describe('the Hooks tab', () => {
  test('/agents/:agent/hooks: keeps its retained rows under the 39g stale warning', async ({
    page,
    request,
  }) => {
    const id = 'e2e-page-hooks-stale';
    agents.add(id);
    await createAgentFile(request, id);
    const created = await bureau(request, 'bureau.hooks.create', {
      name: 'Retained audit hook',
      events: ['review.requested'],
      scope: { kind: 'agent', id },
      action: { type: 'notify', title: 'Audit the review' },
    });
    expect(created.fault).toBeUndefined();

    await page.goto(`/agents/${id}/hooks`);
    await expect(page.getByTestId('agent-hooks')).toContainText('Retained audit hook');

    let failedReads = 0;
    await page.route('**/jsonrpc', async (route) => {
      const call = route.request().postDataJSON() as { method?: string; id?: unknown };
      if (call.method !== 'bureau.hooks.list') {
        await route.fallback();
        return;
      }
      failedReads += 1;
      await route.fulfill({
        json: {
          jsonrpc: '2.0',
          id: call.id,
          error: {
            code: -32000,
            message: 'The Hooks read failed.',
            data: { httpStatus: 503, weftCode: 'Unavailable' },
          },
        },
      });
    });
    await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));

    await expect.poll(() => failedReads).toBe(1);
    await expect(page.getByTestId('agent-tab-stale')).toBeVisible();
    await expect(page.getByTestId('agent-hooks')).toContainText('Retained audit hook');
    await expect(page.getByRole('link', { name: 'Edit', exact: true })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await captureForDesignReview(page, {
      route: '/agents/:agent/hooks',
      tab: 'Hooks',
      state: '39g retained stale',
      source: 'agent-page.spec.ts',
    });
    await page.unroute('**/jsonrpc');
  });
});

test.describe('the Instructions tab', () => {
  test('/agents/:agent/instructions and /agents/:agent/edit?section=references: renders the body as a document, leaves Edit to the header, and says there are no reference documents', async ({
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
    await captureForDesignReview(page, {
      route: '/agents/:agent/instructions',
      tab: 'Instructions',
      state: '39r reference documents source link',
      source: 'agent-page.spec.ts',
    });
    await page.getByTestId('agent-no-references').getByRole('link', { name: 'the editor' }).click();
    await expect(page).toHaveURL(new RegExp(`/agents/${id}/edit\\?section=references$`));
    await expect(page.locator('#agent-reference-documents')).toBeFocused();
    await captureForDesignReview(page, {
      route: '/agents/:agent/edit?section=references',
      state: 'reference documents deep-link focus',
      source: 'agent-page.spec.ts',
    });
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
    await expect(page).toHaveURL(new RegExp(`/agents/${id}/memory(\\?selected=[^&]+)?$`));
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
  test('/agents/:agent/settings: restores an older version as a new version', async ({
    page,
    request,
  }) => {
    const id = 'e2e-page-versions';
    agents.add(id);
    const created = await createAgentFile(request, id, {
      instructions: 'First instructions.',
      model: 'anthropic/claude-haiku-5-5',
      approvals: { 'demo:lookup-order': 'never' },
    });
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

    for (const change of [
      { instructions: 'Third instructions.', model: 'anthropic/claude-sonnet-5-5' },
      {
        instructions: 'Fourth instructions.',
        tools: ['demo:lookup-order', 'demo:issue-refund'],
      },
    ]) {
      const current = await readAgent(request, id);
      const next = await bureau(request, 'bureau.agents.definitions.update', {
        id,
        expectedHash: current.hash,
        definition: { ...current.definition, ...change },
      });
      expect(next.fault).toBeUndefined();
    }

    await page.goto(`/agents/${id}/settings`);

    const versions = page.getByTestId('agent-versions');
    await expect(versions.locator('[data-revision]')).toHaveCount(4);
    await captureForDesignReview(page, {
      route: '/agents/:agent/settings',
      state: '39t current Version 4 with saved versions',
      source: 'agent-page.spec.ts',
    });
    await versions.getByRole('button', { name: 'View Version 3' }).click();
    const versionView = versions.getByTestId('agent-version-view');
    await expect(versionView.getByRole('heading', { name: 'Version 3' })).toBeVisible();
    await expect(versionView.getByTestId('agent-version-changed-from')).toContainText(
      'Changed from Version 2: Model: Claude Haiku 5.5 to Claude Sonnet 5.5',
    );
    await expect(versionView).toContainText('Version 4 is the current version.');
    await expect(versionView.getByTestId('agent-version-instructions')).toContainText(
      'Third instructions.',
    );
    await expect(versionView.getByTestId('agent-version-tools')).toContainText(
      'Lookup order (Never)',
    );
    await expect(versionView.getByTestId('agent-version-tools')).toContainText(
      'Issue refund is not allowed in this version',
    );
    await captureForDesignReview(page, {
      route: '/agents/:agent/settings',
      state: '39u read-only Version 3 detail against current Version 4',
      source: 'agent-page.spec.ts',
    });
    await versions.getByRole('button', { name: 'Versions' }).click();
    // Restore asks first, then saves the old version again as the next one (row 38z).
    await versions.getByRole('button', { name: 'Restore Version 1' }).click();
    await page
      .getByRole('dialog', { name: 'Restore Version 1?' })
      .getByRole('button', { name: 'Restore Version 1' })
      .click();
    await expect(versions.locator('[data-revision]')).toHaveCount(5);
    await captureForDesignReview(page, {
      route: '/agents/:agent/settings',
      state: 'restored version saved list',
      source: 'agent-page.spec.ts',
    });
    const restored = await readAgent(request, id);
    expect(restored.definition?.instructions).toBe('First instructions.');
  });

  test('deletes the agent and returns to the list', async ({ page, request }) => {
    const id = 'e2e-page-delete';
    agents.add(id);
    await createAgentFile(request, id);

    await page.goto(`/agents/${id}/settings`);
    await page.getByRole('button', { name: AGENT_PAGE_COPY.settings.deleteAction }).click();
    // The identifier typed arms the delete (row 39a).
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(AGENT_PAGE_COPY.settings.deleteDialog.typeLabel(id)).fill(id);
    await dialog
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
