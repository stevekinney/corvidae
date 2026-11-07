/**
 * New chat on the sample world (`fixtures/sample-world-seed.ts`, the showcase host) at the browser's
 * sample clock, Monday, Nov 2, 10:46 AM Central time (COR-2016, design rows 23s, 23x, 24b, 24d, 24e,
 * 24f, 24g, 24h, 24i, 24k and 24m of PageNewChat): choosing an agent, typing to Tool runner, sending
 * the first message, the chat a person starts from Workflows ("Ask an agent to write one") with and
 * without a provider and with no agent that can create workflows, and the chat that came of it.
 * "Provider connected" is a captioned state outside the sample world, made by answering the host's
 * provider list as it would with a key in place; the chat the agent created is
 * `fixtures/chat-states.ts`'s `workflow-created`. Each frame is captured for the design review under
 * its own name.
 */
import type { Locator, Page } from '@playwright/test';

import {
  CREATED_WORKFLOW,
  WORKFLOW_CREATED_ASK,
  WORKFLOW_CREATED_REPLY,
} from '../../fixtures/chat-states.ts';
import { SAMPLE_NOW, SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import {
  connectProvider,
  connectProviderWithModels,
  openStatesChat,
} from './chat-states-support.ts';
import { deleteChats } from './chat-support.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, loggedFailedResponse, test } from './fixtures.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'chat-new-workflows.spec.ts';
const PREFILL = 'Help me build a workflow that ';
const REFUND_ASK = 'Please refund order 4471, it arrived damaged.';

/** Opens `path` at 1440 pixels on the sample clock, once New chat holds its greeting. */
async function open(page: Page, path: string): Promise<void> {
  await page.clock.setFixedTime(SAMPLE_NOW);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(path);
  await expect(page.getByTestId('new-chat-welcome').or(blockedRow(page)).first()).toBeVisible();
}

/** Opens the agent list from the pill. */
async function openAgentList(page: Page): Promise<void> {
  await agentPill(page).click();
  await expect(page.getByRole('option').first()).toBeVisible();
}

const trail = (page: Page) => page.getByRole('navigation', { name: 'Breadcrumb' });
const greeting = (page: Page) => page.getByRole('heading', { level: 1 });
const welcome = (page: Page) => page.getByTestId('new-chat-welcome');
const chip = (page: Page) => page.getByTestId('new-chat-source');
const blockedRow = (page: Page) => page.locator('[data-chat-composer-status="blocked"]');
const field = (page: Page) => page.getByRole('textbox', { name: 'Message' });
const send = (page: Page) => page.locator('button[data-chat-send]');
const agentPill = (page: Page) => page.getByRole('combobox', { name: 'Agent' });

/** The shell the page follows (23a, 23s, 23x): Chat active, the top bar, and the breadcrumb "Chat › New chat". */
async function expectShell(page: Page): Promise<void> {
  await expect(trail(page).getByRole('link', { name: 'Chat' })).toBeVisible();
  await expect(trail(page).locator('[aria-current="page"]')).toHaveText('New chat');
  await expect(
    page
      .getByRole('navigation', { name: 'Views' })
      .getByRole('link', { name: 'Chat', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  const banner = page.getByRole('banner');
  await expect(banner.getByRole('button', { name: /^Search everything/ })).toContainText('⌘');
  await expect(banner.getByRole('button', { name: /^Notifications/ })).toBeVisible();
  await expect(banner.getByRole('button', { name: 'Quick settings' })).toBeVisible();
}

/** The box of `locator`, which must be on the page. */
async function boxOf(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box, 'the element is on the page').not.toBeNull();
  return box!;
}

/** Answers the Bureau's agent list as a host would whose agents have none of the Create workflow tool. */
async function withoutWorkflowTool(page: Page): Promise<void> {
  await page.route('**/bureau/jsonrpc', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { method?: string };
    if (body.method !== 'bureau.agents.list') {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const answer = (await response.json()) as {
      result: { agents: { tools?: string[] }[] };
    };
    for (const agent of answer.result.agents) {
      if (agent.tools !== undefined) {
        agent.tools = agent.tools.filter((tool) => tool !== 'bureau:workflows-create');
      }
    }
    await route.fulfill({ response, json: answer });
  });
}

test.describe('Choosing an agent (23s)', () => {
  test('opens the list under the pill, with the shell and the breadcrumb "Chat › New chat" (23s)', async ({
    page,
  }) => {
    await open(page, '/chats/new');
    await expectShell(page);
    await openAgentList(page);
    const options = page.getByRole('option');
    await expect(options.first()).toBeVisible();
    await expect(options.filter({ hasText: 'Tool runner' })).toContainText(
      'Looks an order up, then asks for approval to refund it.',
    );
    await captureForDesignReview(page, {
      route: '/chats/new',
      state: 'choosing an agent',
      source: SOURCE,
    });
  });
});

test.describe('Typing to Tool runner, provider connected (23x)', () => {
  test('greets Tool runner with its sentence over a live composer with Model, Effort and Permissions (23x)', async ({
    page,
  }) => {
    await connectProviderWithModels(page);
    await open(page, '/chats/new?agent=tool-runner');
    await expectShell(page);
    await expect(greeting(page)).toHaveText('What should Tool runner do?');
    await expect(
      welcome(page).getByText('Looks an order up, then asks for approval to refund it.'),
    ).toBeVisible();
    await expect(welcome(page).locator('.ib-new-chat__avatar')).toHaveText('TR');
    await field(page).fill(`${REFUND_ASK} The carrier flagged it. **Check the photo** first.`);
    await expect(page.getByRole('combobox', { name: 'Model' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Effort' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: /Permissions/ })).toBeVisible();
    await expect(send(page)).toBeEnabled();
    await captureForDesignReview(page, {
      route: '/chats/new',
      state: 'provider connected, typing to Tool runner',
      source: SOURCE,
    });
  });
});

test.describe('Sending the first message (24b)', () => {
  test('reads "Starting chat…" with a spinner and keeps the typed text and the selects until the chat page opens (24b)', async ({
    page,
    pageErrors,
  }) => {
    pageErrors.expect({
      pattern: loggedFailedResponse(503, /\/ag-ui\/agents\/tool-runner\/run/),
      reason: 'the test answers the first message’s run with a host that is down',
    });
    await connectProviderWithModels(page);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/ag-ui/agents/tool-runner/run', async (route) => {
      await held;
      await route.fulfill({ status: 503, body: 'down' });
    });
    await open(page, '/chats/new?agent=tool-runner');
    await field(page).fill(REFUND_ASK);

    await send(page).click();

    await expect(send(page)).toContainText('Starting chat…');
    await expect(send(page)).toBeDisabled();
    await expect(send(page).locator('.chat-input-spinner')).toBeVisible();
    await expect(field(page)).toHaveValue(REFUND_ASK);
    // The chat page has not opened: the address, the greeting and the selects are still New chat's.
    expect(new URL(page.url()).pathname).toBe('/chats/new');
    await expect(greeting(page)).toHaveText('What should Tool runner do?');
    await expect(page.getByRole('combobox', { name: 'Model' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Effort' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: /Permissions/ })).toBeVisible();
    await expect(page.locator('.chat-message--user, [data-role="user"]')).toHaveCount(0);
    await captureForDesignReview(page, {
      route: '/chats/new',
      state: 'sending the first message',
      source: SOURCE,
    });

    // A start that fails keeps the text and leaves New chat where it was.
    release();
    await expect(send(page)).not.toContainText('Starting chat…');
    await expect(field(page)).toHaveValue(REFUND_ASK);
    expect(new URL(page.url()).pathname).toBe('/chats/new');
  });

  test('opens the chat page once the run has begun, and empties the box (24b)', async ({
    page,
  }) => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/ag-ui/agents/assistant/run', async (route) => {
      await held;
      await route.continue();
    });
    await open(page, '/chats/new?agent=assistant');
    await field(page).fill('Say hello');

    await send(page).click();

    await expect(send(page)).toContainText('Starting chat…');
    await expect(field(page)).toHaveValue('Say hello');
    release();
    await expect(page).toHaveURL(/\/chats\/(?!new)[^/?]+$/);
    // The sample world is given back as it was: the chat this started is deleted.
    const started = new URL(page.url()).pathname.split('/').pop() ?? '';
    try {
      await expect(page.getByRole('region', { name: 'Chat conversation' })).toContainText(
        'Say hello',
      );
      await expect(field(page)).toHaveValue('');
      await expect(send(page)).not.toContainText('Starting chat…');
    } finally {
      await deleteChats([started], E2E_SHOWCASE_URL);
    }
  });
});

test.describe('New chat from Workflows, provider connected (24d, 24e, 24f)', () => {
  test('preselects Workflow author and says where the person came from in one chip, with no subtitle (24d, 24e)', async ({
    page,
  }) => {
    await connectProviderWithModels(page);
    await open(page, '/chats/new?from=workflows');
    await expectShell(page);

    await expect(welcome(page).locator('.ib-new-chat__avatar')).toHaveText('WA');
    await expect(greeting(page)).toHaveText('What should Workflow author do?');
    await expect(agentPill(page)).toContainText('Workflow author');
    // The breadcrumb stays "Chat › New chat" because the route is /chats/new.
    expect(new URL(page.url()).pathname).toBe('/chats/new');
    await expect(chip(page)).toHaveText('Starting from Workflows');
    // The chip is above the composer, outside its border, and the page says nothing else: no
    // sentence under the greeting, no suggestions, no list of other agents.
    const chipBox = await boxOf(chip(page));
    const composerBox = await boxOf(page.locator('form.chat-input'));
    expect(chipBox.y + chipBox.height).toBeLessThanOrEqual(composerBox.y + 1);
    expect(Math.abs(chipBox.x - composerBox.x)).toBeLessThanOrEqual(2);
    await expect(page.locator('.ib-new-chat__description')).toHaveCount(0);
    await expect(page.getByTestId('new-chat-choices')).toHaveCount(0);
    await expect(page.getByText('Pick an agent and ask it something.')).toHaveCount(0);
  });

  test('prefills "Help me build a workflow that " with the caret after it, and shows the selects and a live Send (24f)', async ({
    page,
  }) => {
    await connectProviderWithModels(page);
    await open(page, '/chats/new?from=workflows');

    await expect(field(page)).toHaveValue(PREFILL);
    const caret = await field(page).evaluate((element) => {
      const box = element as HTMLTextAreaElement;
      return {
        start: box.selectionStart,
        end: box.selectionEnd,
        focused: document.activeElement === box,
      };
    });
    expect(caret).toEqual({ start: PREFILL.length, end: PREFILL.length, focused: true });
    await expect(page.getByRole('combobox', { name: 'Model' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Effort' })).toBeVisible();
    await expect(page.getByRole('combobox', { name: /Permissions/ })).toBeVisible();
    await expect(send(page)).toBeEnabled();
    // It is editable.
    await page.keyboard.type('sends me a summary of open reviews every morning.');
    await expect(field(page)).toHaveValue(
      `${PREFILL}sends me a summary of open reviews every morning.`,
    );
    await field(page).fill(PREFILL);
    await captureForDesignReview(page, {
      route: '/chats/new',
      state: 'from Workflows, provider connected',
      source: SOURCE,
    });
  });
});

test.describe('New chat from Workflows with no provider (24g, 24h)', () => {
  test('keeps the chip over the shared blocked row with no banner, and holds the prefill back until there is a box (24g, 24h)', async ({
    page,
  }) => {
    await open(page, '/chats/new?from=workflows');
    await expectShell(page);

    await expect(greeting(page)).toHaveText('What should Workflow author do?');
    await expect(chip(page)).toHaveText('Starting from Workflows');
    const row = blockedRow(page);
    await expect(row.getByText('Connect a model provider to chat')).toBeVisible();
    await expect(row.getByRole('link', { name: 'Connect a provider' })).toBeVisible();
    await expect(row.getByRole('button', { name: 'Use Assistant' })).toBeVisible();
    await expect(page.locator('.cinder-banner')).toHaveCount(0);
    // The chip is above the blocked row.
    const chipBox = await boxOf(chip(page));
    const rowBox = await boxOf(row);
    expect(chipBox.y + chipBox.height).toBeLessThanOrEqual(rowBox.y + 1);
    // No box, so no prefill anywhere on the page.
    await expect(field(page)).toHaveCount(0);
    await expect(page.getByText('Help me build a workflow')).toHaveCount(0);
    await captureForDesignReview(page, {
      route: '/chats/new',
      state: 'from Workflows, no provider',
      source: SOURCE,
    });

    // The prefill appears in the first box there is: here, Assistant's.
    await row.getByRole('button', { name: 'Use Assistant' }).click();
    await expect(field(page)).toHaveValue(PREFILL);
    await expect(chip(page)).toHaveText('Starting from Workflows');
  });
});

test.describe('New chat from Workflows when no agent can create workflows (24i)', () => {
  test('keeps the chip, reads "Choose an agent", and explains once in the blocked row with no error in the greeting (24i)', async ({
    page,
  }) => {
    await withoutWorkflowTool(page);
    await open(page, '/chats/new?from=workflows');
    await expectShell(page);

    await expect(chip(page)).toHaveText('Starting from Workflows');
    await expect(agentPill(page)).toContainText('Choose an agent');
    const row = blockedRow(page);
    await expect(row).toContainText(
      'No agent can create workflows. Add the Create workflow tool to an agent’s Access tab.',
    );
    await expect(row.getByRole('link', { name: 'Open Agents' })).toHaveAttribute('href', '/agents');
    // The greeting area draws no title, avatar or error; the heading is for screen readers.
    await expect(page.locator('.ib-new-chat__avatar')).toHaveCount(0);
    await expect(welcome(page).getByRole('alert')).toHaveCount(0);
    await expect(greeting(page)).toHaveText('Choose an agent to start with');
    const heading = await boxOf(greeting(page));
    expect(heading.width).toBeLessThanOrEqual(1);
    // The chip, then the pill, then the row.
    const chipBox = await boxOf(chip(page));
    const pillBox = await boxOf(agentPill(page));
    const rowBox = await boxOf(row);
    expect(pillBox.y).toBeGreaterThanOrEqual(chipBox.y + chipBox.height - 1);
    expect(rowBox.y).toBeGreaterThanOrEqual(pillBox.y + pillBox.height - 1);
    await captureForDesignReview(page, {
      route: '/chats/new',
      state: 'from Workflows, no agent can create workflows',
      source: SOURCE,
    });
  });

  test('lets the person take their text to another agent, with the chip kept (24i)', async ({
    page,
  }) => {
    await connectProviderWithModels(page);
    await withoutWorkflowTool(page);
    await open(page, '/chats/new?from=workflows');
    await expect(blockedRow(page)).toBeVisible();

    await openAgentList(page);
    await page.getByRole('option', { name: /Tool runner/ }).click();

    await expect(blockedRow(page)).toHaveCount(0);
    await expect(greeting(page)).toHaveText('What should Tool runner do?');
    await expect(chip(page)).toHaveText('Starting from Workflows');
    await expect(field(page)).toHaveValue(PREFILL);
    await expect(page).toHaveURL(/\?agent=tool-runner&from=workflows$/);
  });
});

test.describe('After the agent created it (24k, 24m)', () => {
  test('shows the person’s message at 10:41 AM with Branch and Copy under the breadcrumb "Chat › Help me build a workflow…" (24k)', async ({
    page,
    request,
  }) => {
    await connectProvider(page);
    await openStatesChat(page, request, 'workflow-created');

    await expect(
      trail(page).getByRole('button', { name: /^Help me build a workflow/ }),
    ).toBeVisible();
    await expect(
      page
        .getByRole('navigation', { name: 'Views' })
        .getByRole('link', { name: 'Chat', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    const message = page
      .getByRole('region', { name: 'Chat conversation' })
      .locator('[data-role="user"], .chat-message--user')
      .first();
    await expect(message).toContainText(WORKFLOW_CREATED_ASK);
    await expect(message).toContainText('10:41 AM');
    await expect(message.getByRole('button', { name: /Branch/ })).toBeVisible();
    await expect(message.getByRole('button', { name: /Copy/ })).toBeVisible();
    await captureForDesignReview(page, {
      route: '/chats/:chat',
      state: 'workflow created from Workflows',
      source: SOURCE,
    });
  });

  test('links the rail row’s “→ Morning briefing” to the workflow page, and says what the agent did (24m)', async ({
    page,
    request,
  }) => {
    await connectProvider(page);
    await openStatesChat(page, request, 'workflow-created');

    const row = page
      .locator('.cinder-tool-call-rail__row[data-cinder-linked]')
      .filter({ hasText: 'Create workflow' });
    await expect(row).toBeVisible();
    await expect(row).toContainText(CREATED_WORKFLOW.name);
    await expect(row).toContainText('0.8s');
    const link = row.getByRole('link', { name: `→ ${CREATED_WORKFLOW.name}` });
    await expect(link).toHaveAttribute('href', `/workflows/${CREATED_WORKFLOW.id}`);
    await expect(page.getByRole('region', { name: 'Chat conversation' })).toContainText(
      WORKFLOW_CREATED_REPLY,
    );
    // A click on the link goes to the page, and a click anywhere else on the row opens the call.
    await row.locator('.cinder-tool-call-rail__hit').click({ position: { x: 12, y: 8 } });
    await expect(page.locator('.ib-chat-panel')).toBeVisible();
    await expect(page).toHaveURL(/\/chats\/sample-chat-workflow-created$/);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/workflows/${CREATED_WORKFLOW.id}$`));
  });
});
