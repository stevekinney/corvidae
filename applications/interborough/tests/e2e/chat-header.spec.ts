/**
 * An open chat's header and composer controls (COR-1967), against the real host: the model, the
 * reasoning effort and the permission mode are always shown, each changes from the composer and is
 * kept across a reload, the note says when a change applies, and the context-window ring reads
 * `bureau.contexts.window` and opens to what fills the window. The cases run at a phone's width and
 * a desktop's, with axe passing.
 */
import type { Page } from '@playwright/test';

import { MODEL_SWITCHER_MODELS } from '@lostgradient/plugin-demo';
import { newThreadId, runToEnd } from './chat-support.ts';
import { expect, test } from './fixtures.ts';
import { SINGLE_MODEL_AGENT_NAME } from './model-agents.ts';

const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 1280, height: 800 },
] as const;

const [SONNET, HAIKU] = MODEL_SWITCHER_MODELS;

const model = (page: Page) => page.getByRole('combobox', { name: 'Model' });
const effort = (page: Page) => page.getByRole('combobox', { name: 'Effort' });
const permission = (page: Page) => page.getByRole('combobox', { name: 'Permissions' });
const summary = (page: Page, setting: string) => page.locator(`[data-setting="${setting}"]`);
const note = (page: Page) => page.getByTestId('chat-settings-note');

async function open(page: Page, request: Parameters<typeof runToEnd>[0], agent: string) {
  const threadId = newThreadId('header');
  await runToEnd(request, agent, threadId, 'Hello');
  await page.goto(`/chats/${threadId}`);
  await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
  return threadId;
}

for (const viewport of VIEWPORTS) {
  test(`shows the model, effort and permission mode and changes each, at ${viewport.width} pixels`, async ({
    page,
    request,
    checkA11y,
  }) => {
    await page.setViewportSize(viewport);
    await open(page, request, 'demo:model-switcher');

    // The header says what the chat runs with before anything was changed.
    await expect(summary(page, 'model')).toHaveText(SONNET.model);
    await expect(summary(page, 'effort')).toHaveText('Agent default');
    await expect(summary(page, 'permission')).toHaveText('Ask on changes');
    await checkA11y(`the chat header, at ${viewport.width} pixels`);

    // The permission mode changes from the composer, and says when it applies.
    await permission(page).selectOption('read-only');
    await expect(summary(page, 'permission')).toHaveText('Read-only');
    await expect(permission(page)).toBeEnabled();
    await expect(note(page)).toContainText('Applies to the next run.');
    await expect(note(page)).toContainText('Every tool that is not read-only is denied.');

    // So does the model, and the header follows it.
    await model(page).selectOption({ label: HAIKU.model });
    await expect(summary(page, 'model')).toHaveText(HAIKU.model);
    await expect(model(page)).toBeEnabled();

    // A reload shows the chat kept both.
    await page.reload();
    await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
    await expect(summary(page, 'permission')).toHaveText('Read-only');
    await expect(summary(page, 'model')).toHaveText(HAIKU.model);
    await expect(permission(page)).toHaveValue('read-only');
    await checkA11y(`the chat header after changes, at ${viewport.width} pixels`);
  });

  test(`reads the context window and opens to its breakdown, at ${viewport.width} pixels`, async ({
    page,
    request,
    checkA11y,
  }) => {
    await page.setViewportSize(viewport);
    await open(page, request, 'demo:model-switcher');

    const ring = page.locator('.weft-context-ring');
    await expect(ring).toBeVisible();
    await expect(ring).toHaveAttribute('aria-label', /^Context window: .* Opens the breakdown$/);

    await ring.click();
    const panel = page.getByTestId('context-window');
    await expect(panel).toBeVisible();
    await expect(panel.locator('[data-category]')).toHaveCount(5);
    await expect(panel.locator('[data-category]').first()).toContainText('Instructions');
    await checkA11y(`the context window breakdown, at ${viewport.width} pixels`);
  });
}

test('changes the effort, says when it applies, and keeps it across a reload', async ({
  page,
  request,
}) => {
  await open(page, request, 'demo:model-switcher');

  await effort(page).selectOption('low');
  await expect(summary(page, 'effort')).toHaveText('Low');
  await expect(effort(page)).toBeEnabled();
  await expect(note(page)).toContainText('Applies to the next run.');

  await page.reload();
  await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
  await expect(summary(page, 'effort')).toHaveText('Low');
  await expect(effort(page)).toHaveValue('low');
});

test('shows the model of an agent that allows one, or none, though it offers no choice', async ({
  page,
  request,
}) => {
  await open(page, request, SINGLE_MODEL_AGENT_NAME);
  await expect(summary(page, 'model')).toHaveText(SONNET.model);
  await expect(model(page)).toBeDisabled();
  await expect(model(page).locator('option')).toHaveText([SONNET.model]);

  await open(page, request, 'demo:echo');
  await expect(summary(page, 'model')).toHaveText('Agent default');
  await expect(model(page)).toBeDisabled();
});
