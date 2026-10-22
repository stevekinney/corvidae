/**
 * Switching a session's model from the composer (COR-1565), against the real host. The seeded
 * `model-switcher` is selectable over two models and names the one that answered, so a session
 * switched between two messages shows which model each ran on, and a reload shows the picker keep
 * the choice. An agent that allows one model, or none, has no picker. The case runs at a phone's
 * width and a desktop's, with axe passing.
 */
import type { Page } from '@playwright/test';

import { MODEL_SWITCHER_MODELS, modelSwitcherReply } from '../../src/host/seed.ts';
import { newThreadId, runToEnd } from './chat-support.ts';
import { expect, test } from './fixtures.ts';
import { SINGLE_MODEL_AGENT_NAME } from './model-agents.ts';

const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 1280, height: 800 },
] as const;

const [SONNET, HAIKU] = MODEL_SWITCHER_MODELS;
const ASSISTANT_ROW = '[data-message-role="assistant"]';

const picker = (page: Page) => page.getByRole('combobox', { name: 'Model' });

async function send(page: Page, text: string): Promise<void> {
  await page.getByRole('textbox').fill(text);
  await page.getByRole('textbox').press('Enter');
}

for (const viewport of VIEWPORTS) {
  test(`switches the model between two messages and keeps it across a reload, at ${viewport.width} pixels`, async ({
    page,
    request,
    checkA11y,
  }) => {
    await page.setViewportSize(viewport);
    const threadId = newThreadId('model');
    await runToEnd(request, 'model-switcher', threadId, 'Which model answers?');
    await page.goto(`/chat/${threadId}`);
    await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');

    // The picker lists the two models the agent allows, with the agent's default selected.
    await expect(picker(page)).toBeVisible();
    await expect(picker(page).locator('option')).toHaveText([SONNET.model, HAIKU.model]);
    await expect(picker(page).locator('option:checked')).toHaveText(SONNET.model);
    const replies = page.locator(ASSISTANT_ROW);
    await expect(replies).toHaveCount(1);
    await expect(replies.last()).toContainText(modelSwitcherReply(SONNET.model));
    await checkA11y(`the model picker, at ${viewport.width} pixels`);

    // Switching takes effect from the next message, which names the new model.
    await picker(page).selectOption({ label: HAIKU.model });
    await expect(picker(page).locator('option:checked')).toHaveText(HAIKU.model);
    await send(page, 'And now?');
    await expect(replies).toHaveCount(2);
    await expect(replies.last()).toContainText(modelSwitcherReply(HAIKU.model));
    await expect(picker(page).locator('option:checked')).toHaveText(HAIKU.model);

    // A reload shows the picker on the model the session was switched to, and the next message
    // still runs on it.
    await page.reload();
    await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
    await expect(picker(page).locator('option:checked')).toHaveText(HAIKU.model);
    await expect(page.locator(ASSISTANT_ROW)).toHaveCount(2);
    await checkA11y(`the model picker after a reload, at ${viewport.width} pixels`);
  });
}

test('has no picker for an agent that allows one model, and none for an agent that allows none', async ({
  page,
  request,
}) => {
  for (const agent of [SINGLE_MODEL_AGENT_NAME, 'echo']) {
    const threadId = newThreadId('single');
    await runToEnd(request, agent, threadId, 'Hello');
    await page.goto(`/chat/${threadId}`);
    await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
    await expect(page.locator(ASSISTANT_ROW)).toHaveCount(1);
    await expect(picker(page)).toHaveCount(0);
  }
});
