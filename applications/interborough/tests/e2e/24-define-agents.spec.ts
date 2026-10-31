/**
 * Defining agents in the application: the editor at `/agents/new` and `/agents/:agent/edit`, against
 * the real host. An agent is a Markdown file in the host's temporary home, so the specs create,
 * edit, and delete real files, and the host's model catalog holds the two models its provider stub
 * offers, so a save really writes. Every view meets axe at the two widths the application is
 * built for.
 */
import type { Page } from '@playwright/test';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { AGENT_EDITOR_COPY, VIEW_COPY } from '../../src/app/copy.ts';
import {
  agentDirectory,
  agentFilePath,
  BASE_DEFINITION,
  createAgentFile,
  faultCodeOf,
  readAgent,
  readCatalog,
  readProviderPaths,
  removeAgent,
} from './agent-support.ts';
import { newThreadId, runToEnd } from './chat-support.ts';
import { E2E_BUREAU_URL } from './e2e-constants.ts';
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

test.describe('a new agent', () => {
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
      const options = page.getByRole('combobox', { name: 'Model' }).getByRole('option');
      await expect(options).toHaveText(
        catalog.models.map((model) => `${model.provider}/${model.model}`),
      );
      await expect(options).toHaveText(['anthropic/claude-sonnet-5', 'anthropic/claude-haiku-4-5']);
      await expect(page.getByRole('checkbox')).toHaveCount(catalog.tools.length);
      await expect(page.getByRole('checkbox', { name: /lookup-order/ })).toBeVisible();

      await page.getByRole('textbox', { name: /^Name/ }).fill('E2E New Agent');
      await expect(page.getByRole('textbox', { name: /^Identifier/ })).toHaveValue('e2e-new-agent');
      await page
        .getByRole('textbox', { name: /^Instructions/ })
        .fill('Answer in one short sentence.');
      await page.getByRole('checkbox', { name: /lookup-order/ }).check();
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
      page.getByRole('textbox', { name: /^Identifier/ }),
      page.getByRole('textbox', { name: /^Description/ }),
      page.getByRole('combobox', { name: 'Model' }),
      page.getByRole('textbox', { name: /^Instructions/ }),
      page.getByRole('button', { name: copy.createAction }),
    ]) {
      await expect(field).toBeInViewport({ ratio: 1 });
    }
    // Five titled sections, in the order a person fills them in. The tools are a group of
    // checkboxes, so its title is the group's legend rather than a heading.
    await expect(editor(page).getByRole('heading', { level: 2 })).toHaveText([
      copy.sections.identity,
      copy.sections.model,
      copy.sections.instructions,
      copy.sections.limits,
    ]);
    await expect(page.getByRole('group', { name: copy.sections.tools })).toBeVisible();
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

  test('refuses a name that makes the identifier new, which is the address of this page', async ({
    page,
  }) => {
    await page.goto('/agents/new');
    await page.getByRole('textbox', { name: /^Name/ }).fill('New');

    await expect(page.getByText(copy.identifierReserved)).toBeVisible();
    await expect(page.getByRole('button', { name: copy.createAction })).toBeDisabled();
  });

  test('reports a taken identifier on its field, for a file and for a code-defined agent, and writes nothing', async ({
    page,
    request,
  }) => {
    await makeAgent(request, 'e2e-taken');
    await page.goto('/agents/new');
    await page.getByRole('textbox', { name: /^Name/ }).fill('E2E Taken');
    await page.getByRole('button', { name: copy.createAction }).click();

    const identifier = page.getByRole('textbox', { name: /^Identifier/ });
    await expect(page.getByText(copy.identifierTaken['agent-file-exists'])).toBeVisible();
    await expect(identifier).toHaveAttribute('aria-invalid', 'true');
    await expect(page).toHaveURL(/\/agents\/new$/);
    const untouched = await readAgent(request, 'e2e-taken');
    expect(untouched.definition?.name).toBe(BASE_DEFINITION.name);

    await identifier.fill('echo-image');
    await page.getByRole('button', { name: copy.createAction }).click();
    await expect(page.getByText(copy.identifierTaken['shadows-code-agent'])).toBeVisible();
    await expect(page).toHaveURL(/\/agents\/new$/);
  });
});

// The second host (`e2e-constants.ts`) has a home with no `configuration.json`, so its model catalog
// is empty, which is what a fresh installation looks like.
test.describe('a new agent on a host with no model provider', () => {
  test.use({ baseURL: E2E_BUREAU_URL });

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

      // Where the file is, and that the identifier cannot change.
      const path = await agentFilePath(request, 'e2e-edit');
      await expect(page.getByTestId('agent-file-path')).toHaveText(path);
      await expect(page.getByRole('textbox', { name: /^Identifier/ })).toHaveAttribute(
        'readonly',
        '',
      );
      await expect(
        page.getByRole('heading', { level: 2, name: copy.revisions.heading }),
      ).toBeVisible();
      await expect(page.getByTestId('agent-revisions-empty')).toContainText(copy.revisions.empty);
      await expectNoSidewaysScroll(page, 'the edit page');

      // The footer sticks to the foot of the outlet, so scrolled all the way down the revision
      // history must start below it, not under its last pixels.
      await page
        .locator('main.weft-shell-outlet')
        .evaluate((element) => void (element.scrollTop = element.scrollHeight));
      const footer = await page.locator('.weft-agent-form__footer').boundingBox();
      const history = await page.locator('.weft-agent-revisions').boundingBox();
      expect(footer, 'the footer is on the page').not.toBeNull();
      expect(history, 'the revision history is on the page').not.toBeNull();
      expect(
        history?.y ?? 0,
        'the revision history starts below the footer, not under it',
      ).toBeGreaterThanOrEqual((footer?.y ?? 0) + (footer?.height ?? 0));
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
      // The editor never touches `skillDescriptors`, and a save leaves the A2A opt-in as it was.
      expect(agent.definition?.skillDescriptors).toEqual(BASE_DEFINITION.skillDescriptors);
      expect(agent.a2a).toBe(false);
      expect(await readFile(path, 'utf8')).toContain('Edited in the browser.');
    });
  }

  test('changes its model to another the catalog offers, and the file says so', async ({
    page,
    request,
  }) => {
    await makeAgent(request, 'e2e-model');
    await page.goto('/agents/e2e-model/edit');
    const select = page.getByRole('combobox', { name: 'Model' });
    // The file wrote an alias, and the select shows the model it names.
    await expect(select).toHaveValue('anthropic/claude-sonnet-5');

    await select.selectOption('anthropic/claude-haiku-4-5');
    await page.getByRole('button', { name: copy.saveAction }).click();
    await expect(page).toHaveURL(/\/agents\/e2e-model$/);

    const agent = await readAgent(request, 'e2e-model');
    expect(agent.definition?.model).toBe('anthropic/claude-haiku-4-5');
    expect(await readFile(await agentFilePath(request, 'e2e-model'), 'utf8')).toContain(
      'model: anthropic/claude-haiku-4-5',
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
    // Its page offers a chat with it and carries no badge, and shows the file's own model, tools
    // and version.
    await expect(page.getByRole('link', { name: 'New chat' }).first()).toBeVisible();
    await expect(page.getByTestId('agent-facts')).toContainText('anthropic/sonnet');
    await expect(page.getByTestId('agent-file-version')).toContainText(
      afterOptIn.hash?.slice(0, 8) ?? '',
    );

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

  test('shows the revision that has run, by its short hash, once the agent has been used', async ({
    page,
    request,
  }) => {
    await makeAgent(request, 'e2e-history');
    await page.goto('/agents/e2e-history/edit');
    await expect(page.getByTestId('agent-revisions-empty')).toBeVisible();
    const first = await readAgent(request, 'e2e-history');
    const hash = first.hash ?? '';

    // A client other than the page starts a run through the AG-UI mount, which a save never does.
    const stream = await runToEnd(request, 'e2e-history', newThreadId('history'), 'Hello');
    expect(stream).toContain('This reply comes from the end-to-end provider stub.');

    await page.goto('/agents/e2e-history/edit');
    const rows = page.getByTestId('agent-revision');
    await expect(rows).toHaveCount(1);
    await expect(rows.first().locator('code')).toHaveText(hash.slice(0, 8));
    await expect(rows.first().locator('time')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/);

    // Editing it makes a new file version, which is a revision only once it has run.
    await page.getByRole('textbox', { name: /^Instructions/ }).fill('A second version.');
    await page.getByRole('button', { name: copy.saveAction }).click();
    await expect(page).toHaveURL(/\/agents\/e2e-history$/);
    await page.goto('/agents/e2e-history/edit');
    await expect(page.getByTestId('agent-revision')).toHaveCount(1);
    const second = await readAgent(request, 'e2e-history');
    await runToEnd(request, 'e2e-history', newThreadId('history'), 'Hello again');
    await page.reload();
    const both = page.getByTestId('agent-revision');
    await expect(both).toHaveCount(2);
    // Most recently run first.
    await expect(both.first().locator('code')).toHaveText((second.hash ?? '').slice(0, 8));
    await expect(both.nth(1).locator('code')).toHaveText(hash.slice(0, 8));
  });

  test('is deleted only after a confirmation, and its file goes', async ({ page, request }) => {
    await makeAgent(request, 'e2e-delete');
    const path = await agentFilePath(request, 'e2e-delete');
    // The agent is in the list until it is deleted.
    await page.goto('/agents');
    await expect(page.locator('[data-agent="e2e-delete"]')).toHaveCount(1);
    await page.getByRole('link', { name: 'End-to-end agent' }).click();
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
      const path = await page.getByTestId('agent-file-path').innerText();
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
    const path = await page.getByTestId('agent-file-path').innerText();
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
      const path = await page.getByTestId('agent-file-path').innerText();
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
      await writeFile(
        path,
        '---\nmodel: openai/gpt-4.1\n---\nA file with a model nobody offers.\n',
      );

      await page.goto('/agents/e2e-invalid/edit');
      await expect(editor(page)).toHaveAttribute('data-state', 'ready');
      const panel = editor(page).locator('[data-editor="invalid"]');
      await expect(panel).toBeVisible();
      await expect(page.getByText(copy.invalid.title)).toBeVisible();
      await expect(page.getByTestId('agent-problem')).toContainText('unknown-model');
      await expect(page.getByTestId('agent-file-path')).toHaveText(path);
      await expect(page.getByRole('textbox', { name: /^Instructions/ })).toHaveCount(0);
      await checkA11y(`invalid file at ${width}px`);

      // Fixing the file on disk and reloading shows the form.
      await writeFile(
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
      await writeFile(
        path,
        '---\nmodel: openai/gpt-4.1\n---\nA file with a model nobody offers.\n',
      );
      await makeAgent(request, 'e2e-listed');

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
      await writeFile(
        path,
        '---\nname: Fixed Listed\nmodel: anthropic/sonnet\n---\nA file with a model the catalog offers.\n',
      );
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
