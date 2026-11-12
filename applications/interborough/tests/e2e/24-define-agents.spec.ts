/**
 * Defining agents in the application: the editor at `/agents/new` and `/agents/:agent/edit`, against
 * the real host. An agent is a Markdown file in the host's temporary home, so the specs create,
 * edit, and delete real files, and the host's model catalog holds the two models its provider stub
 * offers, so a save really writes. Every view meets axe at the two widths the application is
 * built for.
 */
import type { APIRequestContext, Page } from '@playwright/test';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AGENT_EDITOR_COPY } from '../../src/app/copy/agents.ts';
import { VIEW_COPY } from '../../src/app/copy/view-pages.ts';
import { providerDisplayName } from '../../src/routes/settings/models/format-model.ts';
import {
  addTools,
  agentDirectory,
  agentFilePath,
  BASE_DEFINITION,
  closeToolPicker,
  createAgentFile,
  faultCodeOf,
  listedStateOf,
  openToolPicker,
  readAgent,
  readCatalog,
  readProviderPaths,
  removeAgent,
  writeAgentFileAtomically,
} from './agent-support.ts';
import { newThreadId, runToEnd } from './chat-support.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_FIRST_RUN_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

const WIDTHS = [375, 1280] as const;

/** Identifiers this file's specs create, removed after each spec. */
const created = new Set<string>();

test.afterEach(async ({ request }) => {
  for (const id of created) await removeAgent(request, id);
  created.clear();
});

async function makeAgent(
  request: Parameters<typeof createAgentFile>[0],
  id: string,
  definition: Record<string, unknown> = {},
) {
  created.add(id);
  return createAgentFile(request, id, definition);
}

function editor(page: Page) {
  return page.locator('[data-view="agent-editor"]');
}

/**
 * Nothing on the page scrolls sideways. The shell clips the document (`.weft-shell` is
 * `overflow: hidden`), so a page that is too wide scrolls the outlet instead and a measurement of
 * the document passes; the outlet is what must not overflow, as in `15-view-states.spec.ts`.
 */
async function expectNoSidewaysScroll(page: Page, where: string): Promise<void> {
  const outlet = await page.locator('main.weft-shell-outlet').evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  }));
  expect(outlet.scrollWidth, `${where} scrolls the outlet sideways`).toBeLessThanOrEqual(
    outlet.clientWidth,
  );
}

const copy = AGENT_EDITOR_COPY;

/** The option the model field lists for each provider the host can call and has no key for. */
async function unconnectedProviderOptions(request: APIRequestContext): Promise<string[]> {
  const response = await request.get('/host/providers');
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    providers: { name: string; hasKey: boolean }[];
  };
  return body.providers
    .filter((provider) => !provider.hasKey)
    .map((provider) => copy.model.notConnected(providerDisplayName(provider.name)));
}

test.describe('a new agent', () => {
  test('preserves child-agent grants through an editor read and save', async ({
    page,
    request,
  }) => {
    await makeAgent(request, 'e2e-child-agent-preserve', { children: ['demo:echo'] });
    await page.goto('/agents/e2e-child-agent-preserve/edit');
    await expect(editor(page)).toHaveAttribute('data-state', 'ready');
    await captureForDesignReview(page, {
      route: '/agents/:agent/edit',
      state: 'ready',
      source: '24-define-agents.spec.ts',
    });
    await page.getByRole('button', { name: copy.saveAction }).click();
    await expect(page).toHaveURL(/\/agents\/e2e-child-agent-preserve$/);

    const saved = await readAgent(request, 'e2e-child-agent-preserve');
    expect(saved.definition?.children).toEqual(['demo:echo']);
    const text = await readFile(await agentFilePath(request, 'e2e-child-agent-preserve'), 'utf8');
    expect(text).toContain('children:');
    expect(text).toContain('demo:echo');
  });

  for (const width of WIDTHS) {
    test(`is made from what the catalog offers, and written as a file, at ${width} pixels`, async ({
      page,
      request,
      checkA11y,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      created.add('e2e-new-agent');
      await page.goto('/agents/new');
      await expect(editor(page)).toHaveAttribute('data-state', 'ready');
      await expect(page.getByRole('heading', { level: 1, name: copy.createHeading })).toBeVisible();

      // Only the models and tools `bureau.agents.catalog` returns.
      const catalog = await readCatalog(request);
      const unconnectedOptions = await unconnectedProviderOptions(request);
      const model = page.getByRole('combobox', { name: 'Model' });
      // The field holds the chosen model, and opening it as it stands lists every option.
      await model.click();
      const options = page.locator('.cinder-combobox__option-label');
      await expect(options).toHaveText([
        ...catalog.models.map((row) => `${row.provider}/${row.model}`),
        // A provider the host can call and has no key for is listed, disabled.
        ...unconnectedOptions,
      ]);
      await expect(options.first()).toHaveText('anthropic/claude-sonnet-5');
      await expect(page.locator('.cinder-_option-group__label').first()).toHaveText('Anthropic');
      // The chosen model's abilities show under the field.
      await expect(page.getByTestId('agent-model-abilities')).toBeVisible();
      await page.keyboard.press('Escape');
      // A new agent has no tool; the picker offers each tool the catalog lists, once. The count
      // sits beside the Tools title (row 41k).
      const toolsSection = page.getByRole('group', { name: /^Tools/ });
      await expect(toolsSection).toContainText(copy.newAgent.toolCount(0, catalog.tools.length));
      await expect(page.getByRole('checkbox')).toHaveCount(0);
      await openToolPicker(page);
      await expect(page.getByRole('checkbox')).toHaveCount(catalog.tools.length);
      await expect(
        page.getByRole('checkbox', { name: 'demo:lookup-order', exact: true }),
      ).toBeVisible();
      await closeToolPicker(page);

      await page.getByRole('textbox', { name: /^Name/ }).fill('E2E New Agent');
      // The identifier follows the name, shown once (row 41e).
      await expect(page.getByTestId('agent-identifier')).toContainText('e2e-new-agent');
      await page
        .getByRole('textbox', { name: /^Instructions/ })
        .fill('Answer in one short sentence.');
      await addTools(page, ['demo:lookup-order']);
      await expect(toolsSection).toContainText(copy.newAgent.toolCount(1, catalog.tools.length));
      await checkA11y(`new agent at ${width}px`);

      await page.getByRole('button', { name: copy.createAction }).click();
      await expect(page).toHaveURL(/\/agents\/e2e-new-agent$/);

      // The save lands on the agent's page, which offers a chat with the new agent and its
      // editor, and says nothing of A2A.
      const detail = page.locator('[data-view="agents"]');
      await expect(detail).toHaveAttribute('data-state', 'ready');
      await expect(page.getByRole('heading', { level: 1, name: 'E2E New Agent' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'New chat' }).first()).toBeVisible();
      await expect(page.getByRole('link', { name: copy.editAction })).toHaveAttribute(
        'href',
        '/agents/e2e-new-agent/edit',
      );

      const agent = await readAgent(request, 'e2e-new-agent');
      expect(agent.state).toBe('ready');
      expect(agent.a2a).toBe(false);
      expect(agent.definition).toMatchObject({
        name: 'E2E New Agent',
        model: 'anthropic/claude-sonnet-5',
        tools: ['demo:lookup-order'],
        instructions: 'Answer in one short sentence.',
      });
      const text = await readFile(await agentFilePath(request, 'e2e-new-agent'), 'utf8');
      expect(text).toContain('Answer in one short sentence.');
    });
  }

  test('shows every field, and a way to save, at 1280 by 812 without scrolling', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 812 });
    await page.goto('/agents/new');
    await expect(editor(page)).toHaveAttribute('data-state', 'ready');
    for (const field of [
      page.getByRole('textbox', { name: /^Name/ }),
      page.getByTestId('agent-identifier'),
      page.getByRole('textbox', { name: /^Description/ }),
      page.getByRole('combobox', { name: 'Model' }),
      page.getByRole('textbox', { name: /^Instructions/ }),
      page.getByRole('button', { name: copy.createAction }),
    ]) {
      await expect(field).toBeInViewport({ ratio: 1 });
    }
    // Four titled sections, in the order a person fills them in: a new agent has no Guardrails and
    // limits, which the Access tab sets once it is saved (S31). The tools are a group, so its title
    // is the group's legend rather than a heading.
    await expect(
      editor(page).getByRole('form', { name: copy.formLabel }).getByRole('heading', { level: 2 }),
    ).toHaveText([copy.sections.identity, copy.sections.model, copy.sections.instructions]);
    await expect(page.getByRole('group', { name: copy.sections.tools })).toBeVisible();
    // At this width Try it is the panel beside the form, titled by its own heading (row 41n).
    await expect(
      page.getByTestId('agent-try-panel').getByRole('heading', { level: 2, name: copy.try.title }),
    ).toBeVisible();
  });

  for (const width of WIDTHS) {
    test(`shows one line for each tool, and what the model is told only on request, at ${width} pixels`, async ({
      page,
      request,
      checkA11y,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/agents/new');
      await expect(editor(page)).toHaveAttribute('data-state', 'ready');
      const catalog = await readCatalog(request);
      await openToolPicker(page);

      // No row shows more than 120 characters until it is expanded, whatever the tool says.
      const lines = await page.getByTestId('agent-tool-line').allTextContents();
      expect(lines).toHaveLength(catalog.tools.length);
      for (const line of lines) expect(Array.from(line).length).toBeLessThanOrEqual(120);

      // A tool whose description is a long prompt shows the line written for a person.
      const created = catalog.tools.find((tool) => tool.name === 'bureau:workflows-create');
      expect(created?.description.length).toBeGreaterThan(120);
      expect(created?.shortDescription).not.toBeNull();
      const row = page.locator('[data-tool="bureau:workflows-create"]');
      await expect(row.getByTestId('agent-tool-line')).toHaveText(created?.shortDescription ?? '');
      await expect(row.getByTestId('agent-tool-full')).toHaveCount(0);

      // A tool that declares nothing shows its description, which already fits, with nothing to open.
      const lookup = page.locator('[data-tool="demo:lookup-order"]');
      await expect(lookup.getByTestId('agent-tool-line')).toHaveText(
        catalog.tools.find((tool) => tool.name === 'demo:lookup-order')?.description ?? '',
      );
      await expect(lookup.getByRole('button', { name: copy.toolDisclosure })).toHaveCount(0);

      await row.getByRole('button', { name: copy.toolDisclosure }).click();
      await expect(row.getByTestId('agent-tool-full')).toHaveText(created?.description ?? '');
      await expectNoSidewaysScroll(page, 'the form with a tool opened');
      await checkA11y(`new agent with a tool opened at ${width}px`);
    });
  }

  test('chooses tools from a searchable picker grouped by source, marks the ones that ask first, and saves the choice', async ({
    page,
    request,
  }) => {
    created.add('e2e-tool-picker');
    await page.goto('/agents/new');
    await expect(editor(page)).toHaveAttribute('data-state', 'ready');
    const catalog = await readCatalog(request);
    const asking = catalog.tools.filter((tool) => tool.defaultApproval === 'ask');
    const reading = catalog.tools.find((tool) => tool.defaultApproval === 'allow');
    const bureauTools = catalog.tools.filter((tool) => tool.source === 'bureau');
    expect(asking.length, 'a tool that asks first').toBeGreaterThan(0);
    expect(reading, 'a tool that runs without asking').toBeDefined();
    expect(bureauTools.length, 'a tool Bureau adds').toBeGreaterThan(0);

    await openToolPicker(page);
    const picker = page.getByRole('dialog', { name: copy.toolPicker.title });
    // Grouped by source: Bureau's tools sit together under their own heading.
    await expect(picker.locator('fieldset[data-group="bureau"] [data-tool]')).toHaveCount(
      bureauTools.length,
    );
    // Every tool that asks first carries the marker, and no other tool does.
    await expect(picker.getByTestId('agent-tool-standing')).toHaveCount(asking.length);

    // Searching narrows the list to what matches, and says when nothing does.
    const search = picker.getByRole('searchbox', { name: copy.toolPicker.searchLabel });
    await search.fill(reading?.name ?? '');
    await expect(picker.locator('fieldset [data-tool]')).toHaveCount(1);
    await expect(picker.getByTestId('agent-tool-matches')).toHaveText(
      copy.toolPicker.resultCount(1),
    );
    await search.fill('no tool is called this');
    await expect(
      picker.getByRole('heading', { level: 3, name: copy.toolPicker.noMatchesTitle }),
    ).toBeVisible();
    await search.fill('');
    await expect(picker.locator('fieldset [data-tool]')).toHaveCount(catalog.tools.length);

    // Choosing from the picker puts the tools in the form's table, each with its risk and an Asks
    // select at the tool's default (rows 41k, 41l).
    await closeToolPicker(page);
    const asks = asking[0]?.name ?? '';
    await addTools(page, [reading?.name ?? '', asks]);
    const toolsSection = page.getByRole('group', { name: /^Tools/ });
    await expect(toolsSection).toContainText(copy.newAgent.toolCount(2, catalog.tools.length));
    const chosen = page.getByTestId('agent-tools-table');
    await expect(chosen.locator('tbody [data-tool]')).toHaveCount(2);
    await expect(chosen.locator(`[data-tool="${asks}"] select`)).not.toHaveValue('never');
    await expect(chosen.locator(`[data-tool="${reading?.name ?? ''}"] select`)).toHaveValue(
      'never',
    );

    // Clearing one in the picker leaves the other, and the save writes only that one.
    await openToolPicker(page);
    await page.getByRole('checkbox', { name: reading?.name ?? '', exact: true }).uncheck();
    await closeToolPicker(page);
    await expect(toolsSection).toContainText(copy.newAgent.toolCount(1, catalog.tools.length));
    await page.getByRole('textbox', { name: /^Name/ }).fill('E2E Tool Picker');
    await page.getByRole('textbox', { name: /^Instructions/ }).fill('Use the one tool.');
    await page.getByRole('button', { name: copy.createAction }).click();
    await expect(page).toHaveURL(/\/agents\/e2e-tool-picker$/);
    const saved = await readAgent(request, 'e2e-tool-picker');
    expect(saved.definition).toMatchObject({
      tools: [asks],
    });
  });

  test('refuses a name that makes the identifier new, which is the address of this page', async ({
    page,
  }) => {
    await page.goto('/agents/new');
    await page.getByRole('textbox', { name: /^Name/ }).fill('New');

    // Save stays enabled; the submit says why at the name, and focuses it (W35, row 14u).
    const save = page.getByRole('button', { name: copy.createAction, exact: true });
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByText(copy.identifierReserved)).toBeVisible();
    await expect(page.getByRole('textbox', { name: /^Name/ })).toBeFocused();
    await expect(page).toHaveURL(/\/agents\/new$/);
  });

  test('reports a taken identifier on its field, for a file and for a code-defined agent, and writes nothing', async ({
    page,
    request,
  }) => {
    await makeAgent(request, 'e2e-taken');
    await page.goto('/agents/new');
    await page.getByRole('textbox', { name: /^Name/ }).fill('E2E Taken');
    await page.getByRole('button', { name: copy.createAction, exact: true }).click();

    // The name set the identifier, so the name says it is taken (rows 42n, 14u).
    const name = page.getByRole('textbox', { name: /^Name/ });
    await expect(page.getByText(copy.newAgent.nameTaken('E2E Taken'))).toBeVisible();
    await expect(name).toHaveAttribute('aria-invalid', 'true');
    await expect(page).toHaveURL(/\/agents\/new$/);
    const untouched = await readAgent(request, 'e2e-taken');
    expect(untouched.definition?.name).toBe(BASE_DEFINITION.name);

    // A typed identifier a code-defined agent holds is refused at the identifier (row 42y).
    await page.getByRole('button', { name: copy.newAgent.changeIdentifierLabel }).click();
    const identifier = page.getByRole('textbox', { name: /^Identifier/ });
    await identifier.fill('echo-image');
    await page.getByRole('button', { name: copy.createAction, exact: true }).click();
    await expect(page.getByText(copy.identifierTaken('echo-image'))).toBeVisible();
    await expect(identifier).toHaveAttribute('aria-invalid', 'true');
    await expect(page).toHaveURL(/\/agents\/new$/);
  });
});

// The first-run host (`e2e-constants.ts`) is a fresh installation: a home with no `configuration.json`,
// so its model catalog is empty. The second host's home names a provider (the chat-proof agents on
// it need a model), so it no longer shows this state. These cases only read the host, and they run
// before `first-run.spec.ts`, which connects a provider there.
test.describe('a new agent on a host with no model provider', () => {
  test.use({ baseURL: E2E_FIRST_RUN_URL });

  for (const width of WIDTHS) {
    test(`shows where to add a provider instead of the form, at ${width} pixels`, async ({
      page,
      request,
      checkA11y,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const catalog = await readCatalog(request);
      expect(catalog.models).toEqual([]);
      const paths = await readProviderPaths(request);

      await page.goto('/agents/new');
      await expect(editor(page)).toHaveAttribute('data-state', 'ready');
      await expect(page.getByRole('heading', { level: 1, name: copy.createHeading })).toBeVisible();
      await expect(
        page.getByRole('heading', { level: 2, name: copy.noProvider.title }),
      ).toBeVisible();

      // The paths are this installation's own, as the host says them.
      await expect(page.getByTestId('provider-configuration-file')).toHaveText(
        paths.configurationFile,
      );
      expect(paths.configurationFile).toMatch(/configuration\.json$/);
      for (const provider of paths.providers) {
        await expect(page.locator(`[data-provider="${provider.name}"]`)).toContainText(
          provider.secretFile,
        );
      }
      await expect(editor(page)).toContainText('"plugins"');
      await expect(editor(page)).toContainText('chmod 600');

      // No form: nothing to fill in, nothing to choose, nothing to save.
      await expect(editor(page).getByRole('textbox')).toHaveCount(0);
      await expect(editor(page).getByRole('combobox')).toHaveCount(0);
      await expect(editor(page).getByRole('checkbox')).toHaveCount(0);
      await expect(page.getByRole('button', { name: copy.createAction })).toHaveCount(0);
      await expectNoSidewaysScroll(page, 'the no-provider state');
      await checkA11y(`new agent with no provider at ${width}px`);

      // Reloading asks again; there is still no provider, so the state stays.
      await page.getByRole('button', { name: copy.noProvider.reload }).click();
      await expect(page.getByRole('button', { name: copy.noProvider.reload })).toBeEnabled();
      await expect(
        page.getByRole('heading', { level: 2, name: copy.noProvider.title }),
      ).toBeVisible();
    });
  }
});

test.describe('an agent that exists', () => {
  for (const width of WIDTHS) {
    test(`is edited in place, keeps its skill descriptors, and shows its file and history, at ${width} pixels`, async ({
      page,
      request,
      checkA11y,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await makeAgent(request, 'e2e-edit');
      await page.goto('/agents/e2e-edit/edit');
      await expect(editor(page)).toHaveAttribute('data-state', 'ready');
      await expect(
        page.getByRole('heading', { level: 1, name: 'Edit End-to-end agent' }),
      ).toBeVisible();

      // Where the file is, relative to the home with the full path on hover, and that the
      // identifier is one line of text, not a field, because it cannot change.
      const path = await agentFilePath(request, 'e2e-edit');
      await expect(page.getByTestId('agent-file-path')).toHaveText('agents/e2e-edit.md');
      await expect(page.getByTestId('agent-identifier')).toContainText('e2e-edit');
      await expect(page.getByRole('textbox', { name: /^Identifier/ })).toHaveCount(0);
      await expectNoSidewaysScroll(page, 'the edit page');
      await checkA11y(`edit agent at ${width}px`);

      await page.getByRole('textbox', { name: /^Instructions/ }).fill('Edited in the browser.');
      await page.getByRole('button', { name: copy.saveAction }).click();
      await expect(page).toHaveURL(/\/agents\/e2e-edit$/);
      // The save lands on the agent's page, which shows the agent and offers its editor.
      await expect(page.locator('[data-view="agents"]')).toHaveAttribute('data-state', 'ready');
      await expect(page.getByRole('heading', { level: 1, name: 'End-to-end agent' })).toBeVisible();
      await expect(page.getByRole('link', { name: copy.editAction })).toBeVisible();

      const agent = await readAgent(request, 'e2e-edit');
      expect(agent.definition?.instructions).toBe('Edited in the browser.');
      // The editor never touches `card`, and a save leaves the A2A opt-in as it was.
      expect(agent.definition?.card).toEqual(BASE_DEFINITION.card);
      expect(agent.a2a).toBe(false);
      expect(await readFile(path, 'utf8')).toContain('Edited in the browser.');
    });
  }

  test('leaves its model and default effort to the Settings tab, and writes them back as the file had them', async ({
    page,
    request,
  }) => {
    await makeAgent(request, 'e2e-effort', { effort: 'high' });
    const before = await readAgent(request, 'e2e-effort');
    await page.goto('/agents/e2e-effort/edit');

    // The model is text that points to the Settings tab, and there is no field for the effort.
    await expect(page.getByTestId('agent-saved-model-value')).toContainText('Claude Sonnet 5');
    await expect(editor(page).getByRole('combobox')).toHaveCount(0);
    await expect(page.getByLabel(copy.effort.label)).toHaveCount(0);
    await page.getByRole('link', { name: copy.edit.model.settingsTab }).click();
    await expect(page).toHaveURL(/\/agents\/e2e-effort\/settings$/);

    await page.goto('/agents/e2e-effort/edit');
    await page.getByRole('textbox', { name: /^Instructions/ }).fill('Edited, nothing else.');
    await page.getByRole('button', { name: copy.saveAction }).click();
    await expect(page).toHaveURL(/\/agents\/e2e-effort$/);
    const after = await readAgent(request, 'e2e-effort');
    expect(after.definition?.model).toBe(before.definition?.model);
    expect(after.definition?.effort).toBe('high');
    expect(await readFile(await agentFilePath(request, 'e2e-effort'), 'utf8')).toContain(
      'effort: high',
    );
  });

  test('opts into and out of A2A with its switch, saved with the form', async ({
    page,
    request,
  }) => {
    await makeAgent(request, 'e2e-a2a');
    await page.goto('/agents/e2e-a2a/edit');
    const a2a = page.getByRole('switch', { name: copy.a2aLabel });
    await expect(a2a).toHaveAttribute('aria-checked', 'false');

    // The switch alone writes nothing: the opt-in is saved with the rest of the definition.
    await a2a.click();
    await expect(a2a).toHaveAttribute('aria-checked', 'true');
    const beforeSave = await readAgent(request, 'e2e-a2a');
    expect(beforeSave.a2a).toBe(false);
    await page.getByRole('button', { name: copy.saveAction }).click();
    await expect(page).toHaveURL(/\/agents\/e2e-a2a$/);
    const afterOptIn = await readAgent(request, 'e2e-a2a');
    expect(afterOptIn.a2a).toBe(true);
    expect(afterOptIn.definition?.a2a).toBe(true);
    // Its page offers a chat with it and carries no badge, and shows the file's own model and
    // tools. Its versions are on the Settings tab, not in the header.
    await expect(page.getByRole('link', { name: 'New chat' }).first()).toBeVisible();
    await expect(page.getByTestId('agent-facts')).toContainText('Sonnet, Anthropic');
    await expect(page.getByTestId('agent-file-version')).toHaveCount(0);

    await page.goto('/agents/e2e-a2a/edit');
    const again = page.getByRole('switch', { name: copy.a2aLabel });
    await expect(again).toHaveAttribute('aria-checked', 'true');
    await again.click();
    await expect(again).toHaveAttribute('aria-checked', 'false');
    await page.getByRole('button', { name: copy.saveAction }).click();
    await expect(page).toHaveURL(/\/agents\/e2e-a2a$/);
    const afterOptOut = await readAgent(request, 'e2e-a2a');
    expect(afterOptOut.a2a).toBe(false);
    // Opted out of A2A, its page still offers a chat.
    await expect(page.getByRole('link', { name: 'New chat' }).first()).toBeVisible();
  });

  test('marks the version that has run in the Settings tab’s one Versions list, by its short hash', async ({
    page,
    request,
  }) => {
    await makeAgent(request, 'e2e-history');
    const first = await readAgent(request, 'e2e-history');
    const hash = first.hash ?? '';

    // The editor keeps no second list of the versions that ran (sweep W60).
    await page.goto('/agents/e2e-history/edit');
    await expect(editor(page)).toHaveAttribute('data-state', 'ready');
    await expect(page.getByTestId('agent-revision')).toHaveCount(0);

    await page.goto('/agents/e2e-history/settings');
    const versions = page.getByTestId('agent-versions');
    await expect(versions.locator('[data-revision]')).toHaveCount(1);
    await expect(versions.locator('[data-ran]')).toHaveCount(0);
    await expect(versions.locator('.ib-agent-version__hash')).toHaveText(hash.slice(0, 8));

    // A client other than the page starts a run through the AG-UI mount, which a save never does.
    const stream = await runToEnd(request, 'e2e-history', newThreadId('history'), 'Hello');
    expect(stream).toContain('This reply comes from the end-to-end provider stub.');

    await page.reload();
    await expect(versions.locator('[data-ran]')).toHaveCount(1);
    await expect(versions.locator('[data-ran]')).toContainText('Ran');
  });

  test('is deleted only after a confirmation, and its file goes', async ({ page, request }) => {
    await makeAgent(request, 'e2e-delete');
    const path = await agentFilePath(request, 'e2e-delete');
    // The agent is in the list until it is deleted.
    await page.goto('/agents');
    await expect(page.locator('[data-agent="e2e-delete"]')).toHaveCount(1);
    // The row's title is the link to the agent's page; its name carries the identifier beside the
    // title, and the row's icon buttons are links named after the agent too.
    await page.getByRole('link', { name: 'End-to-end agent e2e-delete', exact: true }).click();
    await page.getByRole('link', { name: copy.editAction }).click();
    await expect(page).toHaveURL(/\/agents\/e2e-delete\/edit$/);

    await page.getByRole('button', { name: copy.deleteAction }).click();
    const dialog = page.getByRole('dialog', { name: copy.deleteDialog.title });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/agents\/e2e-delete\/edit$/);
    const kept = await readAgent(request, 'e2e-delete');
    expect(kept.state).toBe('ready');

    await page.getByRole('button', { name: copy.deleteAction }).click();
    await page
      .getByRole('dialog', { name: copy.deleteDialog.title })
      .getByRole('button', { name: copy.deleteDialog.confirm })
      .click();
    // The delete lands on the list, and the agent has left it.
    await expect(page).toHaveURL(/\/agents$/);
    await expect(page.locator('[data-view="agents"]')).toHaveAttribute('data-state', 'ready');
    await expect(page.getByRole('heading', { level: 1, name: 'Agents' })).toBeVisible();
    await expect(page.locator('[data-agent="demo:assistant"]')).toHaveCount(1);
    await expect(page.locator('[data-agent="e2e-delete"]')).toHaveCount(0);
    await expect.poll(() => faultCodeOf(request, 'e2e-delete')).toBe('NotFound');
    const stillThere = await readFile(path, 'utf8').then(
      () => true,
      () => false,
    );
    expect(stillThere).toBe(false);
  });
});

test.describe('the delete confirmation', () => {
  for (const width of WIDTHS) {
    test(`passes axe with the dialog open, at ${width} pixels`, async ({
      page,
      request,
      checkA11y,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await makeAgent(request, 'e2e-dialog');
      await page.goto('/agents/e2e-dialog/edit');
      await page.getByRole('button', { name: copy.deleteAction }).click();
      await expect(page.getByRole('dialog', { name: copy.deleteDialog.title })).toBeVisible();
      await checkA11y(`delete confirmation at ${width}px`);
    });
  }
});

test.describe('a file that changed outside Interborough', () => {
  for (const width of WIDTHS) {
    test(`is not overwritten by a save, and reloads from disk, at ${width} pixels`, async ({
      page,
      request,
      checkA11y,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await makeAgent(request, 'e2e-stale');
      await page.goto('/agents/e2e-stale/edit');
      await page.getByRole('textbox', { name: /^Instructions/ }).fill('Typed in the browser.');

      // Someone edits the file on disk after the page loaded.
      const path = await agentFilePath(request, 'e2e-stale');
      const original = await readFile(path, 'utf8');
      const onDisk = original.replace('You are an end-to-end agent.', 'Hand-edited on disk.');
      await writeFile(path, onDisk);

      await page.getByRole('button', { name: copy.saveAction }).click();
      await expect(editor(page).locator('[data-editor="stale"]')).toBeVisible();
      await expect(page.getByText(copy.stale.title)).toBeVisible();
      await expect(page.getByText('discards your unsaved edits')).toBeVisible();
      await expect(page).toHaveURL(/\/agents\/e2e-stale\/edit$/);
      // Nothing was overwritten.
      expect(await readFile(path, 'utf8')).toBe(onDisk);
      await checkA11y(`changed outside Interborough at ${width}px`);

      await page.getByRole('button', { name: copy.stale.action }).click();
      await expect(editor(page).locator('[data-editor="ready"]')).toBeVisible();
      await expect(page.getByRole('textbox', { name: /^Instructions/ })).toHaveValue(
        'Hand-edited on disk.',
      );

      // A save now names the hash that is on disk, and succeeds.
      await page.getByRole('textbox', { name: /^Instructions/ }).fill('Saved after reloading.');
      await page.getByRole('button', { name: copy.saveAction }).click();
      await expect(page).toHaveURL(/\/agents\/e2e-stale$/);
      const saved = await readAgent(request, 'e2e-stale');
      expect(saved.definition?.instructions).toBe('Saved after reloading.');
    });
  }

  test('is the same state for a delete, which removes nothing', async ({ page, request }) => {
    await makeAgent(request, 'e2e-stale-delete');
    await page.goto('/agents/e2e-stale-delete/edit');
    // The form is filled from the file as it was, and only then does the file change on disk:
    // a form built after the edit would hold the new file's hash, and its delete would be current.
    await expect(editor(page).locator('[data-editor="ready"]')).toBeVisible();
    await expect(page.getByRole('textbox', { name: /^Instructions/ })).toHaveValue(
      BASE_DEFINITION.instructions,
    );
    const path = await agentFilePath(request, 'e2e-stale-delete');
    const original = await readFile(path, 'utf8');
    const onDisk = original.replace('end-to-end agent.', 'edited agent.');
    await writeFile(path, onDisk);

    await page.getByRole('button', { name: copy.deleteAction }).click();
    await page
      .getByRole('dialog', { name: copy.deleteDialog.title })
      .getByRole('button', { name: copy.deleteDialog.confirm })
      .click();
    await expect(page.getByText(copy.stale.title)).toBeVisible();
    expect(await readFile(path, 'utf8')).toBe(onDisk);
  });

  for (const width of WIDTHS) {
    test(`that was deleted on disk is not found when saved, at ${width} pixels`, async ({
      page,
      request,
      checkA11y,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await makeAgent(request, 'e2e-gone');
      await page.goto('/agents/e2e-gone/edit');
      await expect(editor(page)).toHaveAttribute('data-state', 'ready');
      const path = await agentFilePath(request, 'e2e-gone');
      await rm(path);

      await page.getByRole('button', { name: copy.saveAction }).click();
      await expect(editor(page)).toHaveAttribute('data-state', 'not-found');
      await expect(editor(page).getByRole('heading', { level: 1 })).toHaveText(
        VIEW_COPY['agent-editor'].notFound?.title ?? '',
      );
      await expect(page).toHaveURL(/\/agents\/e2e-gone\/edit$/);
      await checkA11y(`deleted on disk at ${width}px`);
    });
  }
});

test.describe('a file the Bureau cannot use', () => {
  for (const width of WIDTHS) {
    test(`opens in an error state with its problem and its path, at ${width} pixels`, async ({
      page,
      request,
      checkA11y,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const path = join(await agentDirectory(request), 'e2e-invalid.md');
      created.add('e2e-invalid');
      await writeAgentFileAtomically(
        path,
        '---\nmodel: openai/gpt-4.1\n---\nA file with a model nobody offers.\n',
      );
      // The Bureau learns of a new file from its watcher, not from the request that asks for it,
      // so the page is opened once the Bureau lists the file.
      await expect.poll(() => faultCodeOf(request, 'e2e-invalid')).toBeUndefined();

      await page.goto('/agents/e2e-invalid/edit');
      await expect(editor(page)).toHaveAttribute('data-state', 'ready');
      const panel = editor(page).locator('[data-editor="invalid"]');
      await expect(panel).toBeVisible();
      await expect(page.getByText(copy.invalid.title)).toBeVisible();
      await expect(page.getByTestId('agent-problem')).toContainText('unknown-model');
      await expect(page.getByTestId('agent-file-path')).toHaveText('agents/e2e-invalid.md');
      await expect(page.getByRole('textbox', { name: /^Instructions/ })).toHaveCount(0);
      await checkA11y(`invalid file at ${width}px`);

      // Fixing the file on disk and reloading shows the form.
      await writeAgentFileAtomically(
        path,
        '---\nname: Fixed\nmodel: anthropic/sonnet\n---\nA file with a model the catalog offers.\n',
      );
      await page.getByRole('button', { name: copy.invalid.action }).click();
      await expect(page.getByRole('textbox', { name: /^Instructions/ })).toHaveValue(
        // The body of a hand-written file keeps its final newline.
        'A file with a model the catalog offers.\n',
      );
    });
  }
});

test.describe('the list of agents', () => {
  for (const width of WIDTHS) {
    test(`offers New agent, and shows an invalid file with its error and its path, at ${width} pixels`, async ({
      page,
      request,
      checkA11y,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const path = join(await agentDirectory(request), 'e2e-invalid-listed.md');
      created.add('e2e-invalid-listed');
      await writeAgentFileAtomically(
        path,
        '---\nmodel: openai/gpt-4.1\n---\nA file with a model nobody offers.\n',
      );
      await makeAgent(request, 'e2e-listed');
      // The Bureau learns of a new file from its watcher, so the list is opened once it lists it.
      await expect.poll(() => listedStateOf(request, 'e2e-invalid-listed')).toBe('invalid');

      await page.goto('/agents');
      await expect(page.locator('[data-view="agents"]')).toHaveAttribute('data-state', 'ready');
      const broken = page.locator('[data-agent="e2e-invalid-listed"]');
      await expect(broken).toHaveAttribute('data-state', 'invalid');
      await expect(broken).toContainText('unknown-model');
      await expect(broken).toContainText(copy.invalidBadge);
      await expect(broken.getByTestId('agent-file-path')).toHaveText(path);
      // A file that loads is listed once, as an agent, and not as an invalid file.
      await expect(page.locator('[data-agent="e2e-listed"]')).toHaveCount(1);
      await expect(page.locator('[data-agent="e2e-listed"]')).not.toHaveAttribute(
        'data-state',
        'invalid',
      );
      await checkA11y(`the list with an invalid file at ${width}px`);

      await broken.getByRole('link', { name: 'e2e-invalid-listed' }).click();
      await expect(page).toHaveURL(/\/agents\/e2e-invalid-listed\/edit$/);
      await expect(page.getByTestId('agent-problem')).toContainText('unknown-model');

      // Fixed on disk, the file is an agent, and the list no longer calls it invalid.
      await writeAgentFileAtomically(
        path,
        '---\nname: Fixed Listed\nmodel: anthropic/sonnet\n---\nA file with a model the catalog offers.\n',
      );
      await expect.poll(() => listedStateOf(request, 'e2e-invalid-listed')).toBe('ready');
      await page.goto('/agents');
      await expect(page.locator('[data-agent="e2e-invalid-listed"]')).toHaveCount(1);
      await expect(page.locator('[data-agent="e2e-invalid-listed"]')).not.toHaveAttribute(
        'data-state',
        'invalid',
      );
    });
  }

  test('New agent opens the form for a new agent', async ({ page }) => {
    await page.goto('/agents');
    await page.getByRole('link', { name: copy.newAction }).click();
    await expect(page).toHaveURL(/\/agents\/new$/);
    await expect(page.getByRole('heading', { level: 1, name: copy.createHeading })).toBeVisible();
  });

  test('offers an agent file its editor, and an agent defined in code none', async ({
    page,
    request,
  }) => {
    await makeAgent(request, 'e2e-entry');
    await page.goto('/agents/demo:assistant');
    await expect(page.getByRole('link', { name: 'New chat' }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: copy.editAction })).toHaveCount(0);

    await page.goto('/agents/e2e-entry');
    await page.getByRole('link', { name: copy.editAction }).click();
    await expect(page).toHaveURL(/\/agents\/e2e-entry\/edit$/);
    await expect(editor(page)).toHaveAttribute('data-state', 'ready');
  });
});

test.describe('an agent that cannot be edited', () => {
  for (const width of WIDTHS) {
    for (const [label, id] of [
      ['one that does not exist', 'e2e-no-such-agent'],
      ['one defined in code', 'demo:assistant'],
    ] as const) {
      test(`is not found for ${label}, at ${width} pixels`, async ({ page, checkA11y }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/agents/${id}/edit`);
        const notFound = VIEW_COPY['agent-editor'].notFound;
        await expect(editor(page)).toHaveAttribute('data-state', 'not-found');
        await expect(editor(page).getByRole('heading', { level: 1 })).toHaveText(
          notFound?.title ?? '',
        );
        await expect(editor(page)).toContainText(notFound?.description ?? '');
        await expect(page.getByRole('textbox', { name: /^Instructions/ })).toHaveCount(0);
        await checkA11y(`${label} at ${width}px`);
      });
    }
  }
});
