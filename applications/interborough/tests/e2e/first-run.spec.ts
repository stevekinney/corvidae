/**
 * First run (COR-1862) against a fresh installation: a host with an empty home, no provider key, no
 * agent file and no chat (`E2E_FIRST_RUN_PORT`, `e2e-server.ts`). Chat's empty state shows the
 * checklist, each step completes from the host's own answer, a provider is connected from the page
 * the checklist links to and a person who came from the agent form returns to it, and a dismissal is
 * kept in this browser.
 *
 * The cases run in file order and each builds on the host the one before left: the first two leave
 * it as they found it, the third connects the provider, creates the agent and says hello. Nothing
 * else opens this host.
 */
import type { Page } from '@playwright/test';

import {
  AGENT_EDITOR_COPY,
  CHAT_COPY,
  FIRST_RUN_COPY,
  MODELS_COPY,
  VIEW_COPY,
} from '../../src/app/copy.ts';
import { E2E_FIRST_RUN_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

test.use({ baseURL: E2E_FIRST_RUN_URL });
test.describe.configure({ mode: 'serial' });

const DISMISSED_KEY = 'interborough:first-run:dismissed';
const KEY = 'e2e-first-run-key-that-must-never-be-printed';
const AGENT_NAME = 'First run agent';
const AGENT_IDENTIFIER = 'first-run-agent';

const checklist = (page: Page) => page.getByTestId('first-run');
const step = (page: Page, name: 'provider' | 'agent' | 'chat') =>
  page.locator(`[data-step="${name}"]`);

/** Saves a key for Anthropic from Settings › Models, and waits for the page to say it is connected. */
async function connectAnthropic(page: Page): Promise<void> {
  const row = page.locator('[data-provider="anthropic"]');
  await row.getByRole('button', { name: /Connect/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('input[type="password"]').fill(KEY);
  await dialog.getByRole('button', { name: /^Connect$/ }).click();
  await expect(row).toContainText(MODELS_COPY.providers.connected);
  expect(await page.content()).not.toContain(KEY);
}

for (const width of [375, 1280] as const) {
  test(`a fresh installation shows the three steps on Chat, none done, at ${width} pixels`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/chats');

    await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'empty');
    await expect(
      page.getByRole('heading', { level: 1, name: VIEW_COPY.chat.empty?.title ?? '' }),
    ).toBeVisible();
    await expect(checklist(page)).toBeVisible();
    await expect(page.locator('[data-step]')).toHaveCount(3);
    for (const name of ['provider', 'agent', 'chat'] as const) {
      await expect(step(page, name)).toHaveAttribute('data-done', 'false');
    }
    await expect(step(page, 'provider').getByRole('link')).toHaveAttribute(
      'href',
      FIRST_RUN_COPY.steps.provider.action.href,
    );
    await expect(step(page, 'agent').getByRole('link')).toHaveAttribute(
      'href',
      FIRST_RUN_COPY.steps.agent.action.href,
    );
    await expect(step(page, 'chat').getByRole('link')).toHaveAttribute(
      'href',
      FIRST_RUN_COPY.steps.chat.action.href,
    );
    // Nothing scrolls sideways, and the steps come before the New chat action.
    const outlet = await page.locator('main.weft-shell-outlet').evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    expect(outlet.scrollWidth).toBeLessThanOrEqual(outlet.clientWidth);
    await checkA11y(`Chat on a fresh installation at ${width}px`);
  });
}

test('dismissing the steps keeps the choice in this browser, across a reload', async ({ page }) => {
  await page.goto('/chats');
  await expect(checklist(page)).toBeVisible();

  await page.getByRole('button', { name: FIRST_RUN_COPY.dismissLabel }).click();

  await expect(checklist(page)).toHaveCount(0);
  expect(await page.evaluate((key) => window.localStorage.getItem(key), DISMISSED_KEY)).toBe(
    'true',
  );
  await page.reload();
  await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'empty');
  await expect(checklist(page)).toHaveCount(0);
  // The empty state is still there, with its own way to start.
  await expect(page.getByRole('link', { name: CHAT_COPY.newChat }).first()).toBeVisible();
});

test('each step completes from its own signal, from connecting a provider to saying hello', async ({
  page,
}) => {
  // A new agent with no provider says so and leads to Models, and Models leads back to the form.
  await page.goto('/agents/new');
  await expect(
    page.getByRole('heading', { level: 2, name: AGENT_EDITOR_COPY.noProvider.title }),
  ).toBeVisible();
  await page.getByRole('link', { name: AGENT_EDITOR_COPY.noProvider.connectAction }).click();
  await expect(page).toHaveURL(/\/settings\/models\?return=%2Fagents%2Fnew$/);
  await expect(page.getByTestId('models-return')).toContainText(MODELS_COPY.returnNotice.title);
  await connectAnthropic(page);
  await page.getByRole('link', { name: MODELS_COPY.returnNotice.action }).click();
  await expect(page).toHaveURL(/\/agents\/new$/);
  await expect(page.getByRole('textbox', { name: /^Name/ })).toBeVisible();

  // The provider step is done and the others are not.
  await page.goto('/chats');
  await expect(step(page, 'provider')).toHaveAttribute('data-done', 'true');
  await expect(step(page, 'agent')).toHaveAttribute('data-done', 'false');
  await expect(step(page, 'chat')).toHaveAttribute('data-done', 'false');
  await expect(step(page, 'provider').getByRole('link')).toHaveCount(0);

  // Creating the agent completes the second step.
  await step(page, 'agent')
    .getByRole('link', { name: FIRST_RUN_COPY.steps.agent.action.label })
    .click();
  await page.getByRole('textbox', { name: /^Name/ }).fill(AGENT_NAME);
  await expect(page.getByRole('textbox', { name: /^Identifier/ })).toHaveValue(AGENT_IDENTIFIER);
  await page.getByRole('textbox', { name: /^Instructions/ }).fill('Answer in one short sentence.');
  await page.getByRole('button', { name: AGENT_EDITOR_COPY.createAction }).click();
  await expect(page).toHaveURL(new RegExp(`/agents/${AGENT_IDENTIFIER}$`));
  await page.goto('/chats');
  await expect(step(page, 'provider')).toHaveAttribute('data-done', 'true');
  await expect(step(page, 'agent')).toHaveAttribute('data-done', 'true');
  await expect(step(page, 'chat')).toHaveAttribute('data-done', 'false');

  // Saying hello completes the third, and the steps are gone.
  await step(page, 'chat')
    .getByRole('link', { name: FIRST_RUN_COPY.steps.chat.action.label })
    .click();
  const composer = page.getByRole('textbox');
  await composer.fill('Hello');
  await composer.press('Enter');
  await expect(page).toHaveURL(/\/chats\/(?!new(?:$|\?))[^/?]+$/);
  await expect(page.getByRole('region', { name: 'Chat conversation' })).toContainText(
    'Hello from the first-run provider stub.',
  );
  await page.goto('/chats');
  await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
  await expect(checklist(page)).toHaveCount(0);
  expect(await page.content()).not.toContain(KEY);
});
