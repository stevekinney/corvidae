/**
 * Switching a session's model from the composer (COR-1565), against the real host. The seeded
 * `model-switcher` is selectable over two models and names the one that answered, so a session
 * switched between two messages shows which model each ran on, and a reload shows the picker keep
 * the choice. An agent that allows one model, or none, has a disabled one. The case runs at a phone's
 * width and a desktop's, with axe passing.
 */
import type { Page } from '@playwright/test';

import { MODEL_SWITCHER_MODELS, modelSwitcherReply } from '@lostgradient/plugin-demo';
import {
  hideModelPicker,
  modelPicker,
  newThreadId,
  runToEnd,
  showModelPicker,
  untilChatLoaded,
} from './chat-support.ts';
import { expect, test } from './fixtures.ts';
import { SINGLE_MODEL_AGENT_NAME } from './model-agents.ts';

const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 1280, height: 800 },
] as const;

const [SONNET, HAIKU] = MODEL_SWITCHER_MODELS;
const ASSISTANT_ROW = '[data-message-role="assistant"]';

async function send(page: Page, text: string): Promise<void> {
  await untilChatLoaded(page);
  const box = page.getByRole('textbox');
  await box.fill(text);
  await expect(box).toHaveValue(text);
  await box.press('Enter');
}

for (const viewport of VIEWPORTS) {
  test(`switches the model between two messages and keeps it across a reload, at ${viewport.width} pixels`, async ({
    page,
    request,
    checkA11y,
  }) => {
    await page.setViewportSize(viewport);
    const threadId = newThreadId('model');
    await runToEnd(request, 'demo:model-switcher', threadId, 'Which model answers?');
    await page.goto(`/chats/${threadId}`);
    await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');

    // The picker lists the two models the agent allows, with the agent's default selected.
    await showModelPicker(page, SONNET.model);
    await expect(modelPicker(page)).toContainText(SONNET.model);
    await modelPicker(page).click();
    const options = page.getByRole('option');
    await expect(options).toHaveCount(2);
    await expect(options.nth(0)).toContainText(SONNET.model);
    await expect(options.nth(1)).toContainText(HAIKU.model);
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape');
    const replies = page.locator(ASSISTANT_ROW);
    await expect(replies).toHaveCount(1);
    await expect(replies.last()).toContainText(modelSwitcherReply(SONNET.model));
    await checkA11y(`the model picker, at ${viewport.width} pixels`);

    // Switching takes effect from the next message, which names the new model.
    await showModelPicker(page);
    await modelPicker(page).click();
    await page.getByRole('option', { name: new RegExp(HAIKU.model) }).click();
    await expect(modelPicker(page)).toContainText(HAIKU.model);
    // The picker is enabled again once the Bureau has taken the switch, which is when the next
    // message is guaranteed to run on the new model.
    await expect(modelPicker(page)).toBeEnabled();
    await hideModelPicker(page);
    await send(page, 'And now?');
    await expect(replies).toHaveCount(2);
    await expect(replies.last()).toContainText(modelSwitcherReply(HAIKU.model));
    await showModelPicker(page, HAIKU.model);
    await expect(modelPicker(page)).toContainText(HAIKU.model);

    // A reload shows the picker on the model the session was switched to, and the next message
    // still runs on it.
    await page.reload();
    await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
    await showModelPicker(page, HAIKU.model);
    await expect(modelPicker(page)).toContainText(HAIKU.model);
    await expect(page.locator(ASSISTANT_ROW)).toHaveCount(2);
    await checkA11y(`the model picker after a reload, at ${viewport.width} pixels`);
  });
}

test('shows the picker disabled for an agent that allows one model, and none for an agent that runs on no model', async ({
  page,
  request,
}) => {
  for (const agent of [SINGLE_MODEL_AGENT_NAME, 'demo:echo']) {
    const threadId = newThreadId('single');
    await runToEnd(request, agent, threadId, 'Hello');
    await page.goto(`/chats/${threadId}`);
    await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator(ASSISTANT_ROW)).toHaveCount(1);
    if (agent === SINGLE_MODEL_AGENT_NAME) {
      // There is no choice to make, so the picker is disabled, and still says which model answers.
      await showModelPicker(page, SONNET.model);
      await expect(modelPicker(page)).toBeDisabled();
      await expect(modelPicker(page)).toContainText(SONNET.model);
    } else {
      // A scripted agent runs on no model, so the composer offers Permissions only (design row 23c).
      await expect(modelPicker(page)).toHaveCount(0);
      await expect(page.getByRole('combobox', { name: /Permissions/ })).toBeVisible();
    }
  }
});
