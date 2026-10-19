/**
 * Defining agents in the application: the editor at `/agents/new` and `/agents/:id/edit`, against
 * the real host. An agent is a Markdown file in the host's temporary home, so the specs create,
 * edit, and delete real files, and the host's model catalog holds the one model its provider stub
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
  removeAgent,
} from './agent-support.ts';
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

      // Only the model the host's provider offers, and only the tool its catalog holds.
      const options = page.getByRole('combobox', { name: 'Model' }).getByRole('option');
      await expect(options).toHaveText(['anthropic/claude-sonnet-5']);
      await expect(page.getByRole('checkbox')).toHaveCount(1);
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

      const agent = await readAgent(request, 'e2e-new-agent');
      expect(agent.state).toBe('ready');
      expect(agent.published).toBe(false);
      expect(agent.definition).toMatchObject({
        name: 'E2E New Agent',
        model: 'anthropic/claude-sonnet-5',
        tools: ['lookup-order'],
        instructions: 'Answer in one short sentence.',
      });
      const text = await readFile(await agentFilePath(request, 'e2e-new-agent'), 'utf8');
      expect(text).toContain('Answer in one short sentence.');
    });
  }

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

    await identifier.fill('assistant');
    await page.getByRole('button', { name: copy.createAction }).click();
    await expect(page.getByText(copy.identifierTaken['shadows-code-agent'])).toBeVisible();
    await expect(page).toHaveURL(/\/agents\/new$/);
  });
});

test.describe('an agent that exists', () => {
  for (const width of WIDTHS) {
    test(`is edited in place, keeps its skills, and shows its file and history, at ${width} pixels`, async ({
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
      await expect(page.getByTestId('agent-revisions-empty')).toHaveText(copy.revisions.empty);
      await checkA11y(`edit agent at ${width}px`);

      await page.getByRole('textbox', { name: /^Instructions/ }).fill('Edited in the browser.');
      await page.getByRole('button', { name: copy.saveAction }).click();
      await expect(page).toHaveURL(/\/agents\/e2e-edit$/);

      const agent = await readAgent(request, 'e2e-edit');
      expect(agent.definition?.instructions).toBe('Edited in the browser.');
      // The editor never touches `skills`, and a save does not publish.
      expect(agent.definition?.skills).toEqual(BASE_DEFINITION.skills);
      expect(agent.published).toBe(false);
      expect(await readFile(path, 'utf8')).toContain('Edited in the browser.');
    });
  }

  test('is published and withdrawn through its own control, never through a save', async ({
    page,
    request,
  }) => {
    await makeAgent(request, 'e2e-publish');
    await page.goto('/agents/e2e-publish/edit');
    const published = page.getByRole('switch', { name: copy.publishedLabel });
    await expect(published).toHaveAttribute('aria-checked', 'false');

    await published.click();
    await expect(published).toHaveAttribute('aria-checked', 'true');
    const afterPublish = await readAgent(request, 'e2e-publish');
    expect(afterPublish.published).toBe(true);

    // A save after publishing uses the file's new hash, and leaves the agent published.
    await page.getByRole('textbox', { name: /^Description/ }).fill('Changed after publishing.');
    await page.getByRole('button', { name: copy.saveAction }).click();
    await expect(page).toHaveURL(/\/agents\/e2e-publish$/);
    const afterSave = await readAgent(request, 'e2e-publish');
    expect(afterSave.published).toBe(true);
    expect(afterSave.definition?.published).toBe(true);

    await page.goto('/agents/e2e-publish/edit');
    const again = page.getByRole('switch', { name: copy.publishedLabel });
    await expect(again).toHaveAttribute('aria-checked', 'true');
    await again.click();
    await expect(again).toHaveAttribute('aria-checked', 'false');
    const afterWithdraw = await readAgent(request, 'e2e-publish');
    expect(afterWithdraw.published).toBe(false);
  });

  test('is deleted only after a confirmation, and its file goes', async ({ page, request }) => {
    await makeAgent(request, 'e2e-delete');
    const path = await agentFilePath(request, 'e2e-delete');
    await page.goto('/agents/e2e-delete/edit');

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
    await expect(page).toHaveURL(/\/agents$/);
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

test.describe('an agent that cannot be edited', () => {
  for (const width of WIDTHS) {
    for (const [label, id] of [
      ['one that does not exist', 'e2e-no-such-agent'],
      ['one defined in code', 'assistant'],
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
