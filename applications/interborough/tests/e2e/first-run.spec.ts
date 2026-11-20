/**
 * First run (COR-1862) against a fresh installation: a host with an empty home, no provider key, no
 * agent file and no chat (`E2E_FIRST_RUN_PORT`, `e2e-server.ts`). New chat, with no agent that can
 * run, is the Agents first-use state (design row 24q); each of Home's checklist steps completes from
 * the host's own answer, a provider is connected from the page the checklist links to and a person
 * who came from the agent form returns to it. The chat list at `/chats` is not the checklist's
 * place: its first use is the list's own empty state (`chat-list.spec.ts`).
 *
 * Home (COR-2016, rows 01y to 02b, 13c to 13j, 14c to 14j) is the first-run checklist on this host
 * too: three steps alone under one heading, then, as the third case connects the provider, makes
 * the agent and says hello, the steps done one by one, and the overview once a chat has happened.
 * This host lists no Assistant (the demo plugin, which contributes it, is off by default), so it
 * offers none: no "Use Assistant", and "Start a chat" waits on the earlier steps until an agent can
 * answer, then opens New chat to pick an agent. The captioned states that name Assistant are on the sample world (`home.spec.ts`).
 *
 * The cases run in file order and each builds on the host the one before left: the first two leave
 * it as they found it, the third connects the provider, creates the agent and says hello. Nothing
 * else opens this host.
 */
import type { Page } from '@playwright/test';

import { AGENT_EDITOR_COPY } from '../../src/app/copy/agents.ts';
import { MODELS_COPY } from '../../src/app/copy/models.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_FIRST_RUN_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

test.use({ baseURL: E2E_FIRST_RUN_URL });
test.describe.configure({ mode: 'serial' });

const KEY = 'e2e-first-run-key-that-must-never-be-printed';
const AGENT_NAME = 'First run agent';
const AGENT_IDENTIFIER = 'first-run-agent';

/** Saves a key for Anthropic from Settings › Models, and waits for the page to say it is connected. */
async function connectAnthropic(page: Page): Promise<void> {
  const row = page.locator('[data-provider="anthropic"]');
  await row.getByRole('button', { name: /Connect/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('input[type="password"]').fill(KEY);
  await dialog.getByRole('button', { name: /^Connect$/ }).click();
  // A passing test leaves the dialog open on its "Connected." state with a single Done (design
  // row 48m), so the dialog is closed from there, as a person does, before the page is used.
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toContainText(MODELS_COPY.providers.connected);
  expect(await page.content()).not.toContain(KEY);
}

for (const width of [375, 1280] as const) {
  test(`a fresh installation shows the Agents first-use state on New chat, with no composer, at ${width} pixels (24q)`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/chats/new');

    await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'empty');
    await expect(page.getByRole('heading', { level: 1, name: 'No agents yet' })).toBeVisible();
    await expect(
      page.getByText(
        'An agent is a model with instructions and tools. Create one, or add a plugin that provides some.',
      ),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'New agent' })).toHaveAttribute(
      'data-cinder-variant',
      'primary',
    );
    await expect(page.getByRole('link', { name: 'New agent' })).toHaveAttribute(
      'href',
      '/agents/new',
    );
    await expect(page.getByRole('link', { name: 'Browse agents' })).toHaveAttribute(
      'data-cinder-variant',
      'secondary',
    );
    // There is nothing to send to, so no composer, and the checklist belongs to Home.
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await expect(page.getByTestId('first-run')).toHaveCount(0);
    // Nothing scrolls sideways.
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
  await expect(navigation.getByRole('link')).toHaveCount(13);
  await expect(navigation.locator('.cinder-side-navigation-group__heading')).toHaveCount(0);
  for (const name of ['Work', 'Build', 'System']) {
    await expect(navigation.getByRole('list', { name, exact: true })).toBeVisible();
    await expect(navigation.getByText(name, { exact: true })).toHaveCount(0);
  }
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
  // Owner, 2026-11-19: the steps alone, under one heading and one sentence.
  test(`Home on a fresh installation is the checklist alone under one heading at ${width} pixels (01y, 01z, 13c, 13d, 13f, 13h, 14c, 14d)`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(homeChecklist(page)).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Set up Interborough' }),
    ).toBeVisible();
    await expect(page.getByTestId('home-date')).toHaveCount(0);
    await expect(page.getByText('Get started', { exact: true })).toHaveCount(0);
    await expect(homeChecklist(page)).not.toContainText('of 3 done');
    const steps = homeSteps(page);
    await expect(steps).toHaveCount(3);
    await expect(steps.nth(0)).toContainText('Connect a provider');
    await expect(steps.nth(0)).toContainText(
      'Agents need a model provider before they can answer.',
    );
    // This host lists no Assistant, so the second step names none.
    await expect(steps.nth(1)).toContainText('Create an agent');
    await expect(steps.nth(1)).not.toContainText('Assistant');
    await expect(steps.nth(1)).toContainText('An agent is a model with instructions and tools.');
    await expect(steps.nth(2)).toContainText('Say hello');
    // No agent can answer yet, so step 3 waits on step 1, held, by the readiness rule every New
    // chat entry point reads (owner, 2026-11-19).
    await expect(steps.nth(2)).toContainText('Waits for step 1: connect a provider first.');
    // Step 1's button is the only primary one.
    await expect(
      homeChecklist(page).locator('.cinder-button[data-cinder-variant="primary"]'),
    ).toHaveText(['Connect a provider']);
    await expect(steps.nth(1).getByRole('link', { name: 'Create an agent' })).toHaveAttribute(
      'data-cinder-variant',
      'secondary',
    );
    // No Assistant is listed here, so none is offered.
    await expect(steps.nth(1).getByRole('button', { name: 'Use Assistant' })).toHaveCount(0);
    await expect(steps.nth(2).getByRole('link', { name: 'Start a chat' })).toHaveCount(0);
    await expect(steps.nth(2).getByRole('button', { name: 'Start a chat' })).toBeDisabled();
    // Only the steps: no counts, Needs you, composer, Needs attention or Recent chats, no banner.
    await expect(page.getByTestId('home-counts')).toHaveCount(0);
    await expect(page.locator('[data-home-card]')).toHaveCount(0);
    await expect(page.getByTestId('home-start-chat')).toHaveCount(0);
    await expect(page.locator('main').getByRole('alert')).toHaveCount(0);
    await captureForDesignReview(page, {
      route: '/',
      state: 'first run, host without Assistant',
      source: 'first-run.spec.ts',
    });
    await checkA11y(`Home on a fresh installation at ${width}px`);
  });
}

// Owner, 2026-11-19: a step that cannot be done yet is shown as waiting on the earlier step, not as
// an active button. This host lists no agent that can answer without a provider.
test('Home’s step 3 waits on step 1 while no agent can answer (02a, 13g, 14c)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await expect(homeChecklist(page)).toHaveAttribute('data-chat-waits-on', 'needs-provider');
  await expect(homeSteps(page).nth(2).getByRole('button', { name: 'Start a chat' })).toBeDisabled();
});

for (const width of [1280, 375] as const) {
  test(`a new agent with no provider reads top to bottom: the description, Connect a provider, the line under it, the steps by hand, at ${width} pixels (COR-2415)`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/agents/new');
    const state = page.getByTestId('agent-no-provider');
    await expect(state).toBeVisible();

    const words = AGENT_EDITOR_COPY.noProvider;
    const boxOf = async (locator: ReturnType<typeof page.locator>) => {
      const box = await locator.boundingBox();
      if (box === null) throw new Error('expected the element to be drawn');
      return box;
    };
    const description = await boxOf(state.getByText(words.description));
    const connect = await boxOf(page.getByTestId('agent-connect-provider'));
    const blocked = await boxOf(page.getByTestId('agent-no-provider-blocked'));
    const byHand = await boxOf(state.getByText(words.byHand, { exact: true }));
    const steps = await boxOf(state.locator('ol.weft-no-provider__steps'));

    // Each piece sits under the one before it, with nothing beside the button.
    const order = [description, connect, blocked, byHand, steps];
    for (const [index, box] of order.entries()) {
      const next = order[index + 1];
      if (next !== undefined) expect(next.y).toBeGreaterThanOrEqual(box.y + box.height - 1);
    }
    // The text reads from the start edge. The action row spans the state and ends at its trailing
    // edge, as every action row does, so the Connect button is the one piece that stands there.
    for (const box of [blocked, byHand, steps]) {
      expect(Math.abs(box.x - description.x)).toBeLessThanOrEqual(24);
    }
    const actionRow = await boxOf(state.locator('.cinder-empty-state-action'));
    expect(
      Math.abs(actionRow.x + actionRow.width - (connect.x + connect.width)),
    ).toBeLessThanOrEqual(2);
    // The page never scrolls sideways.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await captureForDesignReview(page, {
      route: '/agents/new',
      state: 'no provider, the steps under the Connect action',
      source: 'first-run.spec.ts',
    });
    await checkA11y(`a new agent with no provider at ${width}px`);
  });

  test(`a new agent with no provider on a host that keeps its keys in its deployment has no action, and the steps by hand read from the top, at ${width} pixels (COR-2415)`, async ({
    page,
    checkA11y,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    // The host's own answer, with its provider keys locked: the state is then the steps alone.
    await page.route('**/host/paths', async (route) => {
      const response = await route.fetch();
      const paths = (await response.json()) as Record<string, unknown>;
      await route.fulfill({
        response,
        json: { ...paths, locked: { providerKeys: 'deployment', configuration: 'deployment' } },
      });
    });
    await page.goto('/agents/new');
    const state = page.getByTestId('agent-no-provider');
    await expect(state).toBeVisible();

    await expect(page.getByTestId('agent-connect-provider')).toHaveCount(0);
    await expect(page.getByTestId('agent-no-provider-blocked')).toHaveCount(0);
    const description = await state
      .getByText(AGENT_EDITOR_COPY.noProvider.description)
      .boundingBox();
    const steps = await state.locator('ol.weft-no-provider__steps').boundingBox();
    if (description === null || steps === null) throw new Error('expected both to be drawn');
    expect(steps.y).toBeGreaterThanOrEqual(description.y + description.height - 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
    await captureForDesignReview(page, {
      route: '/agents/new',
      state: 'no provider, provider keys locked, no action',
      source: 'first-run.spec.ts',
    });
    await checkA11y(`a new agent with no provider and locked keys at ${width}px`);
  });
}

test('each step completes from its own signal, from connecting a provider to saying hello', async ({
  page,
}) => {
  // A new agent with no provider says so and leads to Models, and Models leads back to the form.
  await page.goto('/agents/new');
  await expect(
    page.getByRole('heading', { level: 2, name: AGENT_EDITOR_COPY.noProvider.title }),
  ).toBeVisible();
  await captureForDesignReview(page, {
    route: '/agents/new',
    state: 'no provider, catalog rows all unavailable',
    source: 'first-run.spec.ts',
  });
  await page.getByRole('link', { name: AGENT_EDITOR_COPY.noProvider.connectAction }).click();
  await expect(page).toHaveURL(/\/settings\/models\?return=%2Fagents%2Fnew$/);
  await expect(page.getByTestId('models-return')).toContainText(MODELS_COPY.returnNotice.title);
  await connectAnthropic(page);
  await page.getByRole('link', { name: MODELS_COPY.returnNotice.action }).click();
  await expect(page).toHaveURL(/\/agents\/new$/);
  await expect(page.getByRole('textbox', { name: /^Name/ })).toBeVisible();

  // Home skips to step 2 once a provider holds a key (14e, 14j); with no agent yet, step 3 waits on
  // step 2.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await expect(homeSteps(page).nth(0)).toContainText('Anthropic is connected.');
  await expect(
    homeSteps(page).nth(1).getByRole('link', { name: 'Create an agent' }),
  ).toHaveAttribute('data-cinder-variant', 'primary');
  await expect(homeChecklist(page)).toHaveAttribute('data-chat-waits-on', 'needs-agent');
  await expect(homeSteps(page).nth(2)).toContainText('Waits for step 2: create an agent first.');
  await expect(page.getByTestId('home-start-chat')).toHaveCount(0);
  await expect(page.getByTestId('home-counts')).toHaveCount(0);

  // New chat has no agent to start with yet, and leads to the agent form.
  await page.goto('/chats/new');
  await expect(page.getByRole('heading', { level: 1, name: 'No agents yet' })).toBeVisible();

  // Creating the agent completes the second step.
  await page.getByRole('link', { name: 'New agent' }).click();
  await page.getByRole('textbox', { name: /^Name/ }).fill(AGENT_NAME);
  await expect(page.getByTestId('agent-identifier')).toContainText(AGENT_IDENTIFIER);
  await page.getByRole('textbox', { name: /^Instructions/ }).fill('Answer in one short sentence.');
  await page.getByRole('button', { name: AGENT_EDITOR_COPY.createAction }).click();
  await expect(page).toHaveURL(new RegExp(`/agents/${AGENT_IDENTIFIER}$`));

  // Step 3 comes alive and is the primary button (14j); the steps stay the whole page.
  await page.goto('/');
  await expect(homeSteps(page).nth(1)).toContainText(`${AGENT_NAME} is ready to use.`);
  await expect(homeChecklist(page)).not.toHaveAttribute('data-chat-waits-on', /.+/);
  await expect(homeSteps(page).nth(2).getByRole('link', { name: 'Start a chat' })).toHaveAttribute(
    'data-cinder-variant',
    'primary',
  );
  await expect(page.getByTestId('home-start-chat')).toHaveCount(0);
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
  // Home is the overview now, and the checklist does not come back (14c).
  await page.goto('/');
  await expect(page.locator('[data-page="home"][data-mode="overview"]')).toBeVisible();
  await expect(homeChecklist(page)).toHaveCount(0);
  expect(await page.content()).not.toContain(KEY);
});
