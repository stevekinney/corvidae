/**
 * The agent editor's model field against the real host: models grouped by provider, a provider the
 * host can call and has no key for listed as a disabled option that points to Settings › Models,
 * and the abilities of the chosen model. The host's home connects one provider (`anthropic`), so
 * the others are not connected. The editor's other fields are in `24-define-agents.spec.ts`; Try it and Duplicate are at the end of this file.
 */
import type { APIRequestContext, Page } from '@playwright/test';
import { existsSync } from 'node:fs';

import { AGENT_EDITOR_COPY, AGENT_PAGE_COPY } from '../../src/app/copy.ts';
import { providerDisplayName } from '../../src/routes/settings/models/format-model.ts';
import {
  addTools,
  agentDirectory,
  bureau,
  faultCodeOf,
  readAgent,
  readCatalog,
  removeAgent,
} from './agent-support.ts';
import { expect, test } from './fixtures.ts';

const copy = AGENT_EDITOR_COPY.model;
const WIDTHS = [375, 1280] as const;

for (const width of WIDTHS) {
  test.describe(`the model field at ${width} pixels`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
    });

    test('groups models by provider and disables a provider that is not connected', async ({
      page,
      request,
      checkA11y,
    }) => {
      const response = await request.get('/host/providers');
      expect(response.ok()).toBe(true);
      const host = (await response.json()) as { providers: { name: string; hasKey: boolean }[] };
      const unconnected = host.providers.filter((provider) => !provider.hasKey);
      // The home connects `anthropic` alone, so this spec has a provider to look at.
      expect(unconnected.length).toBeGreaterThan(0);

      await page.goto('/agents/new');
      const model = page.getByRole('combobox', { name: 'Model' });
      await expect(model).toBeVisible();
      // Opened as it stands, with the chosen model in the field, the list is not narrowed to it.
      await model.click();
      await expect(model).toHaveValue('anthropic/claude-sonnet-5');

      await expect(page.locator('.cinder-_option-group__label').first()).toHaveText('Anthropic');
      for (const provider of unconnected) {
        const option = page.getByRole('option', {
          name: copy.notConnected(providerDisplayName(provider.name)),
        });
        await expect(option).toHaveAttribute('aria-disabled', 'true');
      }
      // The listbox the field controls is the scroller, and its list is 16rem tall at either width
      // (the docked sheet does not let it grow to the sheet's height).
      const listbox = page.getByRole('listbox');
      const listHeight = await listbox.evaluate((element) => {
        const style = getComputedStyle(element);
        return (
          element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
        );
      });
      expect(listHeight).toBe(256);
      // The list is open with disabled rows in it; a scrolling list must be reachable by keyboard.
      await checkA11y('the model list open with providers that are not connected');

      // The arrow keys stop on a provider that is not connected, so the list scrolls to it by
      // keyboard and its reason can be read; they do not skip it.
      const first = unconnected[0];
      if (first === undefined) throw new Error('Expected a provider that is not connected.');
      const disabledOption = page.getByRole('option', {
        name: copy.notConnected(providerDisplayName(first.name)),
      });
      const disabledId = await disabledOption.getAttribute('id');
      const optionIds = await page
        .getByRole('option')
        .evaluateAll((rows) => rows.map((row) => row.id));
      const steps = optionIds.indexOf(disabledId ?? '');
      expect(steps).toBeGreaterThan(0);
      await model.press('Home');
      for (let step = 0; step < steps; step += 1) await model.press('ArrowDown');
      await expect(model).toHaveAttribute('aria-activedescendant', disabledId ?? '');
      await expect(disabledOption).toBeInViewport();
      // Enter on it chooses nothing and leaves the list open.
      await model.press('Enter');
      await expect(model).toHaveAttribute('aria-expanded', 'true');
      await expect(model).toHaveValue('anthropic/claude-sonnet-5');

      // Pressing a provider that is not connected chooses nothing.
      await disabledOption.click({ force: true });
      await page.keyboard.press('Escape');
      await expect(model).toHaveValue('anthropic/claude-sonnet-5');

      // The line under the field links to the page that connects a provider.
      const hint = page.getByTestId('agent-model-unconnected');
      await expect(hint).toContainText(
        copy.unconnectedLead(unconnected.map(label)).split(' in')[0]!,
      );
      await hint.getByRole('link', { name: copy.settingsLink }).click();
      await expect(page).toHaveURL(/\/settings\/models$/);
    });

    test('keeps the model list inside a short screen', async ({ page }) => {
      await page.setViewportSize({ width, height: 240 });
      await page.goto('/agents/new');
      await page.getByRole('combobox', { name: 'Model' }).click();
      const box = await page.getByRole('listbox').boundingBox();
      expect(box).not.toBeNull();
      // The docked sheet hangs from the bottom edge, so a panel taller than the screen would push
      // its first rows above it, out of reach. (The anchored panel places itself by the field.)
      if (width < 768) expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
      expect(box?.height ?? Infinity).toBeLessThanOrEqual(240);
    });

    test('shows the abilities of the chosen model', async ({ page }) => {
      await page.goto('/agents/new');
      const abilities = page.getByTestId('agent-model-abilities');
      await expect(abilities).toBeVisible();
      await expect(abilities).toContainText(copy.abilities.tools);

      const model = page.getByRole('combobox', { name: 'Model' });
      await model.fill('');
      await page.getByRole('option', { name: /^anthropic\/claude-haiku-4-5/ }).click();
      await expect(model).toHaveValue('anthropic/claude-haiku-4-5');
      await expect(abilities).toBeVisible();
      await expect(abilities).toContainText(/context window/);
    });
  });
}

function label(provider: { name: string }): string {
  return providerDisplayName(provider.name);
}

/*
 * Try it and Duplicate (COR-1965), against the real host.
 *
 * Try it chats with the form as it stands, saved or not, through `bureau.agents.try` (COR-1911). It
 * writes no agent file and no memory, leaves the chat out of the chat list, and ends the chat (the
 * Bureau deletes its context, and the agent with it) when the drawer closes and when the page is
 * left. Duplicate fills the form for a new agent from a built-in agent, to be named and created as a
 * file the person can edit; a name that is taken is refused. The host's provider stub answers, so
 * the tried agent really replies.
 */

const words = AGENT_EDITOR_COPY;
const STUB_REPLY = 'This reply comes from the end-to-end provider stub.';

/** Identifiers this file's specs create, removed after each spec. */
const created = new Set<string>();

test.afterEach(async ({ request }) => {
  for (const id of created) await removeAgent(request, id);
  created.clear();
});

type ChatRow = { id: string; origin: string; agentName: string };

/** The chats the Bureau lists: every one the chat list shows, or only those of an `origin`. */
async function chatRows(request: APIRequestContext, origin?: string): Promise<ChatRow[]> {
  const answer = await bureau(
    request,
    'bureau.contexts.list',
    origin === undefined ? {} : { origin },
  );
  expect(answer.fault).toBeUndefined();
  return (answer.result as { contexts: ChatRow[] }).contexts;
}

/** The wire fault code reading a chat answers with, or `undefined` while it reads. */
async function chatFault(request: APIRequestContext, contextId: string) {
  const answer = await bureau(request, 'bureau.contexts.get', { contextId });
  return answer.fault?.code;
}

/** The ids of the agents the Bureau lists, files and code. */
async function agentIds(request: APIRequestContext): Promise<string[]> {
  const answer = await bureau(request, 'bureau.agents.definitions.list', { limit: 100 });
  expect(answer.fault).toBeUndefined();
  return (answer.result as { agents: { id: string }[] }).agents.map((agent) => agent.id);
}

function drawer(page: Page) {
  return page.getByRole('dialog', { name: words.try.title });
}

/** Opens Try it on the open editor, and starts a chat with `message`. */
async function startTrial(page: Page, message: string): Promise<string> {
  await page.getByRole('button', { name: words.try.action }).click();
  await drawer(page).getByRole('textbox', { name: words.try.messageLabel }).fill(message);
  await drawer(page).getByRole('button', { name: words.try.send }).click();
  await expect(drawer(page).getByRole('region', { name: words.try.chatLabel })).toBeVisible();
  const contextId = await page.getByTestId('agent-try').getAttribute('data-context-id');
  expect(contextId).toBeTruthy();
  return contextId ?? '';
}

test.describe('Try it', () => {
  test('chats with the unsaved draft, writes no file or memory, and ends the chat with the drawer', async ({
    page,
    request,
    checkA11y,
  }) => {
    const before = await agentIds(request);
    const chatsBefore = await chatRows(request);
    await page.goto('/agents/new');
    await expect(page.locator('[data-view="agent-editor"]')).toHaveAttribute('data-state', 'ready');
    // Nothing here is saved: a name and instructions typed into a new agent.
    await page.getByRole('textbox', { name: /^Name/ }).fill('Trial agent');
    await page.getByRole('textbox', { name: /^Instructions/ }).fill('Answer in one word.');

    const contextId = await startTrial(page, 'Hello draft');

    // The tried agent replies, and a follow-up reaches it too.
    const region = drawer(page).getByRole('region', { name: words.try.chatLabel });
    await expect(region.getByText(STUB_REPLY)).toBeVisible();
    await checkA11y('the trial chat in the drawer');
    await region.getByRole('textbox').fill('And again');
    await region.getByRole('textbox').press('Enter');
    await expect(region.getByText(STUB_REPLY)).toHaveCount(2);

    // It is a throwaway chat under a name that is in no catalog.
    const context = await bureau(request, 'bureau.contexts.get', { contextId });
    expect(context.result).toMatchObject({ origin: 'try' });
    const agentName = (context.result as { agentName: string }).agentName;
    expect(agentName.startsWith('try:')).toBe(true);
    const tried = await chatRows(request, 'try');
    expect(tried.map((row) => row.id)).toEqual([contextId]);
    // The chat list does not show it, and nothing was saved: no file, no agent, no memory.
    const chatsNow = await chatRows(request);
    expect(chatsNow.map((row) => row.id)).toEqual(chatsBefore.map((row) => row.id));
    expect(await agentIds(request)).toEqual(before);
    expect(await faultCodeOf(request, 'trial-agent')).toBe('NotFound');
    const directory = await agentDirectory(request);
    expect(existsSync(`${directory}/trial-agent.md`)).toBe(false);
    const memories = await bureau(request, 'bureau.memory.list', { agentId: agentName });
    expect(
      memories.fault !== undefined ||
        (memories.result as { memories: unknown[] }).memories.length === 0,
    ).toBe(true);

    // Closing the drawer ends the chat: its context is deleted and the page is as it was.
    await drawer(page).getByRole('button', { name: words.try.close }).click();
    await expect(drawer(page)).toBeHidden();
    await expect.poll(() => chatFault(request, contextId)).toBe('NotFound');
    expect(await chatRows(request, 'try')).toEqual([]);
    expect(new URL(page.url()).pathname).toBe('/agents/new');
  });

  test('ends the chat when the page is left', async ({ page, request }) => {
    await page.goto('/agents');
    await page.getByRole('link', { name: words.newAction }).first().click();
    await expect(page.locator('[data-view="agent-editor"]')).toHaveAttribute('data-state', 'ready');
    const contextId = await startTrial(page, 'Hello');
    expect(await chatFault(request, contextId)).toBeUndefined();

    // Back to the list, by the history entry the shell made: the editor unmounts with its chat.
    await page.goBack();
    await expect(page).toHaveURL(/\/agents$/);
    await expect.poll(() => chatFault(request, contextId)).toBe('NotFound');
    expect(await chatRows(request, 'try')).toEqual([]);
  });

  test('says why a definition with a tool a trial may not have cannot be tried, and starts no chat', async ({
    page,
    request,
  }) => {
    // A trial may not schedule work, write memory or delegate: it is refused by the tool's name.
    const refused = 'bureau:workflows-create';
    const catalog = await readCatalog(request);
    test.skip(
      !catalog.tools.some((tool) => tool.name === refused),
      `this host does not offer ${refused}`,
    );
    await page.goto('/agents/new');
    await expect(page.locator('[data-view="agent-editor"]')).toHaveAttribute('data-state', 'ready');
    await addTools(page, [refused]);

    await page.getByRole('button', { name: words.try.action }).click();
    await drawer(page).getByRole('textbox', { name: words.try.messageLabel }).fill('Hello');
    await drawer(page).getByRole('button', { name: words.try.send }).click();
    await expect(page.getByTestId('agent-try-failure')).toContainText(refused);
    expect(await chatRows(request, 'try')).toEqual([]);
  });
});

test.describe('Duplicate', () => {
  test('copies a built-in agent into an editable file agent, and refuses a name that is taken', async ({
    page,
    request,
  }) => {
    created.add('single-model-copy');
    await page.goto('/agents/single-model');
    await page.getByRole('link', { name: AGENT_PAGE_COPY.duplicate }).click();

    // The form for a new agent, filled from the built-in agent, with nothing written yet.
    await expect(page).toHaveURL(/\/agents\/new\?from=single-model$/);
    await expect(page.locator('[data-view="agent-editor"]')).toHaveAttribute('data-state', 'ready');
    await expect(page.getByTestId('agent-copied-from')).toBeVisible();
    await expect(page.getByRole('textbox', { name: /^Name/ })).toHaveValue(
      words.copyName('single-model'),
    );
    await expect(page.getByRole('textbox', { name: /^Identifier/ })).toHaveValue(
      'single-model-copy',
    );
    expect(await faultCodeOf(request, 'single-model-copy')).toBe('NotFound');

    await page.getByRole('button', { name: words.createAction }).click();
    await expect(page).toHaveURL(/\/agents\/single-model-copy$/);

    // A file agent now, with what the built-in agent stated about itself.
    const detail = await readAgent(request, 'single-model-copy');
    expect(detail).toMatchObject({ source: 'file', state: 'ready' });
    expect(detail.definition).toMatchObject({
      name: words.copyName('single-model'),
      a2a: false,
    });
    // And an editable one: its page offers Edit, and the editor opens on it.
    await page.getByRole('link', { name: words.editAction }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: words.editHeading('single-model copy') }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: words.saveAction })).toBeVisible();

    // The same copy again is refused: the identifier is taken, and nothing else is written.
    await page.goto('/agents/new?from=single-model');
    await expect(page.locator('[data-view="agent-editor"]')).toHaveAttribute('data-state', 'ready');
    await page.getByRole('button', { name: words.createAction }).click();
    await expect(page.getByText(words.identifierTaken['agent-file-exists'])).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/agents/new');
  });

  test('keeps a file agent’s approvals and budgets in the copy', async ({ page, request }) => {
    created.add('approvals-source');
    created.add('approvals-source-copy');
    const made = await bureau(request, 'bureau.agents.definitions.create', {
      id: 'approvals-source',
      definition: {
        name: 'Approvals source',
        description: 'Has approvals and budgets',
        model: 'anthropic/claude-sonnet-5',
        tools: ['demo:lookup-order'],
        skillDescriptors: [],
        stepLimit: 12,
        costBudget: { perRunUsd: 2 },
        toolApproval: { 'demo:lookup-order': 'always' },
        instructions: 'Ask first.',
      },
    });
    expect(made.fault).toBeUndefined();

    await page.goto('/agents/approvals-source');
    await page.getByRole('link', { name: AGENT_PAGE_COPY.duplicate }).click();
    await expect(page.getByRole('textbox', { name: /^Identifier/ })).toHaveValue(
      'approvals-source-copy',
    );
    await page.getByRole('button', { name: words.createAction }).click();
    await expect(page).toHaveURL(/\/agents\/approvals-source-copy$/);

    const detail = await bureau(request, 'bureau.agents.definitions.get', {
      id: 'approvals-source-copy',
    });
    expect(detail.result).toMatchObject({
      definition: {
        stepLimit: 12,
        costBudget: { perRunUsd: 2 },
        toolApproval: { 'demo:lookup-order': 'always' },
        instructions: 'Ask first.',
      },
    });
  });
});
