/**
 * The agent editor's model field against the real host: models grouped by provider, a provider the
 * host can call and has no key for listed as a disabled option that points to Settings › Models,
 * and the abilities of the chosen model. The host's home connects one provider (`anthropic`), so
 * the others are not connected. The editor's other fields are in `24-define-agents.spec.ts`; Try it and Duplicate are at the end of this file.
 */
import type { APIRequestContext, Page, Route } from '@playwright/test';
import { existsSync } from 'node:fs';

import { AGENT_EDITOR_COPY, AGENT_PAGE_COPY } from '../../src/app/copy/agents.ts';
import { NAVIGATION_COPY } from '../../src/app/copy/shell.ts';
import { agentDuplicatePath } from '../../src/lib/agent-paths.ts';
import {
  modelDisplayName,
  providerDisplayName,
} from '../../src/routes/settings/models/format-model.ts';
import {
  addTools,
  agentDirectory,
  bureau,
  faultCodeOf,
  readAgent,
  readCatalog,
  removeAgent,
} from './agent-support.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { expect, test } from './fixtures.ts';
import { readBoxes } from './read-boxes.ts';

const copy = AGENT_EDITOR_COPY.model;
const WIDTHS = [375, 1280] as const;

/** Select a runnable fixture row by its catalog declaration, never by a guessed model id. */
async function selectRunnableModel(page: Page, request: APIRequestContext): Promise<string> {
  const catalog = await readCatalog(request);
  const row = catalog.models.find((candidate) => candidate.availability !== 'unavailable');
  if (row === undefined) throw new Error('Expected the E2E catalog to offer one runnable model.');
  const model = page.getByRole('combobox', { name: 'Model' });
  if ((await model.getAttribute('aria-expanded')) !== 'true') await model.click();
  const display = modelDisplayName(row.model);
  await page.getByRole('option', { name: new RegExp(`^${display}`) }).click();
  await expect(model).toHaveValue(display);
  return display;
}

/** Gives one real catalog row the exact capabilities the design's Balanced witness declares. */
async function withBalancedCatalogFixture(page: Page): Promise<void> {
  await page.route('**/jsonrpc', async (route: Route) => {
    const call = route.request().postDataJSON() as { method?: string } | null;
    if (call?.method !== 'bureau.agents.catalog') return route.fallback();
    const response = await route.fetch();
    const body = (await response.json()) as {
      result?: { models?: Array<Record<string, unknown>> };
    };
    let changed = false;
    const models = body.result?.models?.map((row) => {
      if (changed || row['availability'] === 'unavailable') return row;
      changed = true;
      return {
        ...row,
        modelClass: 'Balanced',
        contextWindowTokens: 1_000_000,
        tools: true,
        structuredOutput: false,
        streaming: false,
        modalities: { text: { input: true }, image: { input: true } },
      };
    });
    await route.fulfill({
      response,
      json: { ...body, result: { ...body.result, ...(models === undefined ? {} : { models }) } },
    });
  });
}

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
      await expect(model).toHaveValue('');
      const selected = await selectRunnableModel(page, request);
      await model.click();

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
      // The model list's options only: the default effort select below holds options of its own.
      const optionIds = await page
        .getByRole('listbox')
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
      await expect(model).toHaveValue(selected);

      // Pressing a provider that is not connected chooses nothing.
      await disabledOption.click({ force: true });
      await page.keyboard.press('Escape');
      await expect(model).toHaveValue(selected);

      // The line under the field links to the page that connects a provider.
      const hint = page.getByTestId('agent-model-unconnected');
      await expect(hint).toContainText(
        copy.unconnectedLead(unconnected.map(label)).split(' in')[0]!,
      );
      await hint.getByRole('link', { name: copy.settingsLink }).click();
      await page.getByRole('button', { name: 'Discard and leave' }).click();
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

    test('/agents/new new-agent model display names filter and show the chosen model abilities', async ({
      page,
      request,
    }) => {
      await page.goto('/agents/new');
      await selectRunnableModel(page, request);
      const abilities = page.getByTestId('agent-model-abilities');
      await expect(abilities).toBeVisible();
      await expect(abilities).toContainText(copy.abilities.tools);

      const model = page.getByRole('combobox', { name: 'Model' });
      await model.fill('claude haiku 4.5');
      const option = page.getByRole('option', { name: /^Claude Haiku 4\.5/ });
      await expect(option).toBeVisible();
      await expect(page.getByRole('option', { name: /^Claude Sonnet 5/ })).toHaveCount(0);
      if (width === 375) {
        const navigation = page.getByRole('navigation', { name: NAVIGATION_COPY.tabBar });
        const listbox = page.getByRole('listbox');
        await expect(navigation).toBeVisible();
        await navigation.getByRole('button', { name: NAVIGATION_COPY.moreTab }).click({
          trial: true,
        });
        const { dock, panel } = await readBoxes(page, { dock: navigation, panel: listbox });
        expect(panel.y + panel.height).toBeLessThanOrEqual(dock.y);
      }
      await captureForDesignReview(page, {
        route: '/agents/new',
        state: 'model display names, filtered picker',
        source: 'agent-editor.spec.ts',
      });
      await option.click();
      await expect(model).toHaveValue('Claude Haiku 4.5');
      await expect(abilities).toBeVisible();
      await expect(abilities).toContainText(/context$/);
      await captureForDesignReview(page, {
        route: '/agents/new',
        state: 'model display name selected',
        source: 'agent-editor.spec.ts',
      });
    });

    test('/agents/new captures the declared Balanced model capabilities', async ({
      page,
      request,
    }) => {
      await withBalancedCatalogFixture(page);
      await page.goto('/agents/new');
      const selected = await selectRunnableModel(page, request);
      const abilities = page.getByTestId('agent-model-abilities');
      await expect(abilities).toContainText('Balanced');
      await expect(abilities).toContainText(copy.abilities.tools);
      await expect(abilities).toContainText(copy.abilities.images);
      await expect(abilities).toContainText('1M context');
      await page.getByRole('combobox', { name: 'Model' }).click();
      await expect(page.getByRole('option', { name: new RegExp(`^${selected}`) })).toContainText(
        'Balanced, tools, images, 1M context',
      );
      await page.keyboard.press('Escape');
      await captureForDesignReview(page, {
        route: '/agents/new',
        state: 'Balanced, tools, images, 1M context',
        source: 'agent-editor.spec.ts',
      });
    });

    test('offers the chosen model’s efforts, and clears one the next model cannot do', async ({
      page,
      request,
      checkA11y,
    }) => {
      const effort = page.getByLabel(AGENT_EDITOR_COPY.effort.label);
      await page.goto('/agents/new');
      await selectRunnableModel(page, request);
      await expect(effort.locator('option')).toHaveText([
        'None',
        'Low',
        'Medium',
        'High',
        'Extra high',
        'Maximum',
      ]);
      await effort.selectOption('max');
      await checkA11y('the default effort chosen');

      const model = page.getByRole('combobox', { name: 'Model' });
      await model.fill('');
      await page.getByRole('option', { name: /^Claude Haiku 4\.5/ }).click();
      await expect(model).toHaveValue('Claude Haiku 4.5');
      await expect(effort).toHaveValue('');
      await expect(effort).toBeDisabled();
      await expect(page.getByText(AGENT_EDITOR_COPY.effort.notSupportedByModel)).toBeVisible();
      await expect(page.getByTestId('agent-effort-notice')).toContainText(
        AGENT_EDITOR_COPY.effort.cleared('Maximum', 'anthropic/claude-haiku-4-5'),
      );
      await checkA11y('the default effort cleared by a model that cannot do it');
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
 * Bureau deletes its context, and the agent with it) on Reset and when the page is left. At the
 * suite's desktop width it is a panel always open beside the form (row 41n). Duplicate fills the form for a new agent from a built-in agent, to be named and created as a
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

/** The Try it panel beside the form. */
function drawer(page: Page) {
  return page.getByTestId('agent-try-panel');
}

/** Starts a chat with `message` from the Try it panel on the open editor. */
async function startTrial(page: Page, message: string): Promise<string> {
  await drawer(page).getByRole('textbox', { name: 'Message' }).fill(message);
  await drawer(page).getByRole('button', { name: /^Send/ }).click();
  await expect(drawer(page).getByRole('region', { name: words.try.chatLabel })).toBeVisible();
  const contextId = await page.getByTestId('agent-try').getAttribute('data-context-id');
  expect(contextId).toBeTruthy();
  return contextId ?? '';
}

test.describe('Try it', () => {
  test('chats with the unsaved draft, writes no file or memory, and ends the chat on Reset', async ({
    page,
    request,
    checkA11y,
  }) => {
    const before = await agentIds(request);
    const chatsBefore = await chatRows(request);
    await page.goto('/agents/new');
    await expect(page.locator('[data-view="agent-editor"]')).toHaveAttribute('data-state', 'ready');
    await selectRunnableModel(page, request);
    // Nothing here is saved: a name and instructions typed into a new agent.
    await page.getByRole('textbox', { name: /^Name/ }).fill('Trial agent');
    await page.getByRole('textbox', { name: /^Instructions/ }).fill('Answer in one word.');

    const contextId = await startTrial(page, 'Hello draft');

    // The tried agent replies, and a follow-up reaches it too.
    const region = drawer(page).getByRole('region', { name: words.try.chatLabel });
    await expect(region.getByText(STUB_REPLY)).toBeVisible();
    await checkA11y('the trial chat in the Try it panel');
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

    // Reset ends the chat: its context is deleted, the panel is back at its composer, and the page
    // is as it was.
    await drawer(page).getByRole('button', { name: words.try.startOver }).click();
    await expect(drawer(page).getByRole('region', { name: words.try.chatLabel })).toBeHidden();
    await expect.poll(() => chatFault(request, contextId)).toBe('NotFound');
    expect(await chatRows(request, 'try')).toEqual([]);
    expect(new URL(page.url()).pathname).toBe('/agents/new');
  });

  test('ends the chat when the page is left', async ({ page, request }) => {
    await page.goto('/agents');
    await page.getByRole('link', { name: words.newAction }).first().click();
    await expect(page.locator('[data-view="agent-editor"]')).toHaveAttribute('data-state', 'ready');
    await selectRunnableModel(page, request);
    const contextId = await startTrial(page, 'Hello');
    expect(await chatFault(request, contextId)).toBeUndefined();

    // Back to the list, by the history entry the shell made: the editor unmounts with its chat.
    await page.goBack();
    await page.getByRole('button', { name: 'Discard and leave' }).click();
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
    await selectRunnableModel(page, request);
    await addTools(page, [refused]);

    await drawer(page).getByRole('textbox', { name: 'Message' }).fill('Hello');
    await drawer(page).getByRole('button', { name: /^Send/ }).click();
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
    await expect(page.getByText(words.identifierTaken('single-model-copy'))).toBeVisible();
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
        card: [],
        limits: { steps: 12, cost: { run: 2 } },
        approvals: { 'demo:lookup-order': 'always' },
        instructions: 'Ask first.',
      },
    });
    expect(made.fault).toBeUndefined();

    // A file agent's page offers Edit, not Duplicate (COR-2020: Duplicate is for an agent that
    // cannot be edited here), so its copy is made from Duplicate's own address.
    await page.goto('/agents/approvals-source');
    await expect(
      page.getByTestId('agent-header').getByRole('link', { name: AGENT_EDITOR_COPY.editAction }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: AGENT_PAGE_COPY.duplicate })).toHaveCount(0);
    await page.goto(agentDuplicatePath('approvals-source'));
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
        limits: { steps: 12, cost: { run: 2 } },
        approvals: { 'demo:lookup-order': 'always' },
        instructions: 'Ask first.',
      },
    });
  });
});
