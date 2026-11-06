/**
 * First run (COR-1862) against a fresh installation: a host with an empty home, no provider key, no
 * agent file and no chat (`E2E_FIRST_RUN_PORT`, `e2e-server.ts`). New chat's empty state (no agent
 * can run) shows the checklist, each step completes from the host's own answer, a provider is
 * connected from the page the checklist links to and a person who came from the agent form returns
 * to it, and a dismissal is kept in this browser. The chat list at `/chats` is not the checklist's
 * place: its first use is the list's own empty state (`chat-list.spec.ts`).
 *
 * Home (COR-2016, rows 01y to 02b, 13c to 13j, 14c to 14j) is the first-run checklist on this host
 * too: three steps under a welcome line with Recent chats empty, then, as the third case connects
 * the provider, makes the agent and says hello, two steps left, one step left, and the overview
 * once a chat has happened. This host lists no Assistant (the demo plugin, which contributes it, is
 * off by default), so it offers none: no "Use Assistant", and "Start a chat" opens New chat to pick
 * an agent. The captioned states that name Assistant are on the sample world (`home.spec.ts`).
 *
 * The cases run in file order and each builds on the host the one before left: the first two leave
 * it as they found it, the third connects the provider, creates the agent and says hello. Nothing
 * else opens this host.
 */
import type { Page } from '@playwright/test';

import { AGENT_EDITOR_COPY, FIRST_RUN_COPY, MODELS_COPY, VIEW_COPY } from '../../src/app/copy.ts';
import { captureForDesignReview } from './design-review-capture.ts';
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
  test(`a fresh installation shows the three steps on New chat, none done, at ${width} pixels`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/chats/new');

    await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'empty');
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: VIEW_COPY.chat.emptyByPattern?.['/chats/new']?.title ?? '',
      }),
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
    await checkA11y(`New chat on a fresh installation at ${width}px`);
  });
}

test('Home on a fresh installation shows the grouped sidebar with no Reviews count (14f)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  const navigation = page.getByRole('navigation', { name: 'Views' });
  await expect(navigation.getByRole('link')).toHaveCount(12);
  await expect(navigation.locator('.cinder-side-navigation-group__heading')).toHaveText([
    'Work',
    'Build',
    'System',
  ]);
  await expect(page.locator('.weft-shell-sidebar__name')).toHaveText('Interborough');
  // Nothing is waiting on the person, so Reviews carries no count and its name is its label.
  await expect(navigation.getByRole('link', { name: 'Reviews', exact: true })).toBeVisible();
  await expect(
    navigation.getByRole('link', { name: 'Reviews', exact: true }).locator('.cinder-badge'),
  ).toHaveCount(0);
  const bar = page.getByRole('banner');
  await expect(bar.getByRole('navigation', { name: 'Breadcrumb' })).toHaveText('Home');
  const search = bar.getByRole('button', { name: /^Search everything/ });
  await expect(search).toContainText('Search everything');
  await expect(search).toContainText('⌘K');
  await captureForDesignReview(page, {
    route: '/',
    state: 'first run fresh installation',
    source: 'first-run.spec.ts',
  });
});

const homeChecklist = (page: Page) => page.getByTestId('home-first-run');
const homeSteps = (page: Page) => homeChecklist(page).locator('.cinder-steps__item');

for (const width of [375, 1280] as const) {
  test(`Home on a fresh installation is the Get started checklist under a welcome line at ${width} pixels (01y, 01z, 13c, 13d, 13f, 13h, 14c, 14d)`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(homeChecklist(page)).toBeVisible();
    await expect(page.getByTestId('home-date')).toHaveText(
      'Welcome. Three steps to your first chat.',
    );
    await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toHaveClass(
      /cinder-sr-only/,
    );
    await expect(page.getByRole('heading', { level: 2, name: 'Get started' })).toBeVisible();
    await expect(homeChecklist(page)).toContainText('0 of 3 done');
    const steps = homeSteps(page);
    await expect(steps).toHaveCount(3);
    await expect(steps.nth(0)).toContainText('Connect a provider');
    await expect(steps.nth(0)).toContainText(
      'Agents need a model provider before they can answer.',
    );
    await expect(steps.nth(1)).toContainText('Create an agent, or start from Assistant');
    await expect(steps.nth(1)).toContainText('Assistant works now; other agents need a provider.');
    await expect(steps.nth(2)).toContainText('Say hello');
    await expect(steps.nth(2)).toContainText('Send a first message to see a chat run end to end.');
    // Step 1's button is the only primary one; Use Assistant is the quiet link.
    await expect(
      homeChecklist(page).locator('.cinder-button[data-cinder-variant="primary"]'),
    ).toHaveText(['Connect a provider']);
    await expect(steps.nth(1).getByRole('link', { name: 'Create an agent' })).toHaveAttribute(
      'data-cinder-variant',
      'secondary',
    );
    // No Assistant is listed here, so none is offered; step 3 is live all the same.
    await expect(steps.nth(1).getByRole('button', { name: 'Use Assistant' })).toHaveCount(0);
    const start = steps.nth(2).getByRole('link', { name: 'Start a chat' });
    await expect(start).toHaveAttribute('data-cinder-variant', 'secondary');
    await expect(start).not.toHaveAttribute('aria-disabled', 'true');
    await expect(start).toHaveAttribute('href', '/chats/new');
    // The counts, Needs you, the composer and the provider row are not drawn, and no banner says it.
    await expect(page.getByTestId('home-counts')).toHaveCount(0);
    await expect(page.locator('[data-home-card="Needs you"]')).toHaveCount(0);
    await expect(page.getByTestId('home-start-chat')).toHaveCount(0);
    await expect(page.locator('[data-home-card="Needs attention"]')).toHaveCount(0);
    await expect(page.locator('main').getByRole('alert')).toHaveCount(0);
    // Below the checklist, Recent chats is a compact empty state with a chat disc.
    const recent = page.locator('[data-home-card="Recent chats"]');
    await expect(recent.getByRole('heading', { level: 3, name: 'No chats yet' })).toBeVisible();
    await expect(recent).toContainText('Your chats appear here once you send a first message.');
    await expect(recent.locator('.cinder-empty-state-icon svg')).toBeVisible();
    await expect(recent.getByRole('link', { name: 'All chats' })).toHaveCount(0);
    const checklistBox = await homeChecklist(page).boundingBox();
    const recentBox = await recent.boundingBox();
    expect(checklistBox!.y + checklistBox!.height).toBeLessThan(recentBox!.y);
    if (width >= 1024) expect(checklistBox!.width).toBeLessThan(recentBox!.width);
    await captureForDesignReview(page, {
      route: '/',
      state: 'first run, host without Assistant',
      source: 'first-run.spec.ts',
    });
    await checkA11y(`Home on a fresh installation at ${width}px`);
  });
}

test('Home’s step 3 is live while steps 1 and 2 are open (02a, 13g, 14c)', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await homeSteps(page).nth(2).getByRole('link', { name: 'Start a chat' }).click();
  await expect(page).toHaveURL(/\/chats\/new$/);
});

test('dismissing the steps keeps the choice in this browser, across a reload', async ({ page }) => {
  await page.goto('/chats/new');
  await expect(checklist(page)).toBeVisible();

  await page.getByRole('button', { name: FIRST_RUN_COPY.dismissLabel }).click();

  await expect(checklist(page)).toHaveCount(0);
  // The shell keeps a personal choice under the identity it was made by
  // (`interborough:identity:[workspace,actor]:<key>`), so the key is found by its ending.
  expect(
    await page.evaluate(
      (key) =>
        Object.entries(window.localStorage)
          .filter(([name]) => name.endsWith(`:${key}`))
          .map(([, value]) => value),
      DISMISSED_KEY,
    ),
  ).toEqual(['true']);
  await page.reload();
  await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'empty');
  await expect(checklist(page)).toHaveCount(0);
  // The empty state is still there, with its own way forward.
  await expect(page.getByRole('link', { name: 'Open plugins' })).toBeVisible();
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

  // Home skips to step 2 once a provider holds a key, and the composer comes back (14e, 14j).
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('home-date')).toHaveText('Welcome. Two steps left.');
  await expect(homeChecklist(page)).toContainText('1 of 3 done');
  await expect(homeSteps(page).nth(0)).toContainText('Anthropic is connected.');
  await expect(
    homeSteps(page).nth(1).getByRole('link', { name: 'Create an agent' }),
  ).toHaveAttribute('data-cinder-variant', 'primary');
  // The box that starts a chat comes back with a provider; no agent is listed yet, so there is
  // nobody to send to.
  await expect(
    page.getByTestId('home-start-chat').getByPlaceholder('Ask an agent to do something'),
  ).toBeVisible();
  await expect(page.getByTestId('home-counts')).toHaveCount(0);

  // The provider step is done and the others are not, where the empty New chat page shows them.
  await page.goto('/chats/new');
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

  // Home says one step left, Start a chat is its primary button, and the composer is there (14j).
  await page.goto('/');
  await expect(page.getByTestId('home-date')).toHaveText('Welcome. One step left.');
  await expect(homeChecklist(page)).toContainText('2 of 3 done');
  await expect(homeSteps(page).nth(1)).toContainText(`${AGENT_NAME} is ready to use.`);
  await expect(homeSteps(page).nth(2).getByRole('link', { name: 'Start a chat' })).toHaveAttribute(
    'data-cinder-variant',
    'primary',
  );
  const homeComposer = page.getByTestId('home-start-chat');
  await expect(homeComposer.getByPlaceholder('Ask an agent to do something')).toBeVisible();
  await expect(homeComposer.getByRole('combobox', { name: 'Agent' })).toContainText(AGENT_NAME);
  await expect(homeComposer.getByRole('button', { name: 'Send' })).toBeEnabled();
  await captureForDesignReview(page, {
    route: '/',
    state: 'first run, steps 1 and 2 done',
    source: 'first-run.spec.ts',
  });

  // Saying hello completes the third, and the steps are gone.
  await homeSteps(page).nth(2).getByRole('link', { name: 'Start a chat' }).click();
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
  // Home is the overview now, and the checklist does not come back (14c).
  await page.goto('/');
  await expect(page.getByTestId('home-counts')).toBeVisible();
  await expect(homeChecklist(page)).toHaveCount(0);
  expect(await page.content()).not.toContain(KEY);
});
