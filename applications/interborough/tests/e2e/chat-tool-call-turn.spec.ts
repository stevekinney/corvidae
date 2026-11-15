/**
 * The long turn of the ToolCallOptions board on the Chat page (COR-2016, design rows 21o, 21p, 21q,
 * and the comparisons 21a, 21b and 21c): thirty tool calls in one turn, one failed and one waiting
 * on the person, beside the chat list at 1280 pixels with a provider connected. The chat is outside
 * the sample world, so the showcase host's own Bureau operations are answered with this chat's
 * records (`fixtures/tool-call-turn.ts`) and every other chat stays the sample world's, except the
 * Oct 30 chat the Runs board owns, which the frame's list does not draw. The three comparisons the
 * board draws and did not choose (a tree on edge, chips grouped by tool, a dense table) are not
 * built, which the last tests check on the page that is. Each frame is captured for the design
 * review under its own name.
 */
import type { APIRequestContext, Locator, Page, Route } from '@playwright/test';

import { SAMPLE_NOW, SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { SAMPLE_WORLD_THREADS } from '../../fixtures/sample-world-records.ts';
import {
  TOOL_CALL_TURN_CALLS,
  TOOL_CALL_TURN_MESSAGE,
  TOOL_CALL_TURN_QUESTION,
  TOOL_CALL_TURN_THREAD,
  TOOL_CALL_TURN_TITLE,
  toolCallTurnContext,
  toolCallTurnMessages,
} from '../../fixtures/tool-call-turn.ts';
import { captureForDesignReview } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';

test.use({ baseURL: E2E_SHOWCASE_URL, timezoneId: SAMPLE_TIME_ZONE });

const SOURCE = 'chat-tool-call-turn.spec.ts';

/** The Oct 30 chat of the Runs board, which the long turn's frame does not list. */
const UNLISTED = 'sample-chat-order-4468';

/** The width the frame draws the chat list at (row 21p); the divider remembers it. */
const LIST_WIDTH = 250;

/** Answers the host's provider list as it would with a key in place. */
async function connectProvider(page: Page): Promise<void> {
  await page.route('**/host/providers', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { providers: { hasKey: boolean }[] };
    await route.fulfill({
      response,
      json: {
        ...body,
        providers: body.providers.map((provider) => ({
          ...provider,
          hasKey: true,
          connected: true,
        })),
      },
    });
  });
}

/** What a request to the Bureau's JSON-RPC mount asks. */
interface Operation {
  readonly method?: string;
  readonly id?: unknown;
  readonly params?: {
    readonly contextId?: string;
    readonly origin?: string;
    readonly titleContains?: string;
    readonly activity?: string;
  };
}

const operationOf = (route: Route): Operation =>
  JSON.parse(route.request().postData() ?? '{}') as Operation;

/**
 * Opens the long turn's chat at 1280 pixels on the sample clock with a provider connected. The
 * Bureau answers for this chat from `fixtures/tool-call-turn.ts` (its record, its list entry and its
 * thread) as it would for a chat it held; the run it parks on is not there to attach to, which is
 * how a chat answers once its run is no longer live.
 */
async function openLongTurn(page: Page, request: APIRequestContext, height = 1100): Promise<void> {
  const read = await request.post(`${E2E_SHOWCASE_URL}/bureau/jsonrpc`, {
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'bureau.contexts.get',
      params: { contextId: SAMPLE_WORLD_THREADS.refund },
    },
  });
  const kind = ((await read.json()) as { result: Record<string, unknown> }).result;
  const context = toolCallTurnContext(kind);
  await connectProvider(page);
  await page.addInitScript((width) => {
    try {
      localStorage.setItem('interborough-chats', String(width));
    } catch {
      // The divider is left where it is.
    }
  }, LIST_WIDTH);
  await page.route('**/bureau/jsonrpc', async (route) => {
    const body = operationOf(route);
    if (body.method === 'bureau.contexts.get' && body.params?.contextId === TOOL_CALL_TURN_THREAD) {
      await route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result: context } });
      return;
    }
    const lists =
      body.method === 'bureau.contexts.list' &&
      (body.params?.origin === undefined || body.params.origin === 'chat') &&
      body.params?.titleContains === undefined &&
      (body.params?.activity === undefined || body.params.activity === 'awaiting-input');
    if (!lists) {
      await route.fallback();
      return;
    }
    const response = await route.fetch();
    const listed = (await response.json()) as {
      result: { contexts: Record<string, unknown>[] };
    };
    const contexts = [...listed.result.contexts, context]
      .filter((entry) => entry['id'] !== UNLISTED)
      .toSorted(
        (left, right) =>
          Date.parse(String(right['updatedAt'])) - Date.parse(String(left['updatedAt'])),
      );
    await route.fulfill({
      response,
      json: { ...listed, result: { ...listed.result, contexts } },
    });
  });
  await page.route(`**/ag-ui/threads/${TOOL_CALL_TURN_THREAD}/messages`, (route) =>
    route.fulfill({
      json: { threadId: TOOL_CALL_TURN_THREAD, messages: toolCallTurnMessages() },
    }),
  );
  await page.route(`**/ag-ui/threads/${TOOL_CALL_TURN_THREAD}/run`, (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' })}\n\n`,
    }),
  );
  await page.clock.setFixedTime(SAMPLE_NOW);
  await page.setViewportSize({ width: 1280, height });
  await page.goto(`/chats/${TOOL_CALL_TURN_THREAD}`);
  await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
  await expect(rail(page)).toBeVisible();
  await expect(page.locator('[data-approval-decision]')).toBeVisible();
}

const trail = (page: Page) => page.getByRole('navigation', { name: 'Breadcrumb' });
const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Views' });
const chatList = (page: Page) => page.getByRole('region', { name: 'Chats' });
const openChat = (page: Page) => page.getByRole('region', { name: 'Open chat' });
const rail = (page: Page) => page.locator('.cinder-tool-call-rail');
const railRows = (page: Page): Locator => rail(page).locator('[data-cinder-tool-call-row]');
const rowOf = (page: Page, tool: string): Locator => railRows(page).filter({ hasText: tool });
const chatRow = (page: Page, title: string): Locator =>
  page.locator('[data-chat]').filter({ hasText: title });

const REFUND = 'Please refund order 4471, it arrived damaged.';

test.describe('the long turn beside the chat list (21o, 21p, 21q)', () => {
  test('copies the shell: Chat active, Reviews still 2, the amber Health dot, the breadcrumb and the top bar (21o)', async ({
    page,
    request,
  }) => {
    await openLongTurn(page, request);
    const navigation = sidebar(page);
    await expect(navigation.getByRole('link', { name: 'Chat' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // The approval would make it three; the board's frame leaves the badge at the sample world's two.
    await expect(navigation.getByRole('link', { name: 'Reviews, 2 need you' })).toContainText('2');
    await expect(
      navigation.getByRole('link', { name: /^Health/ }).locator('.cinder-status-dot'),
    ).toHaveAttribute('data-cinder-status', 'warning');
    await expect(trail(page).getByRole('link', { name: 'Chat' })).toBeVisible();
    await expect(trail(page).getByRole('button', { name: TOOL_CALL_TURN_TITLE })).toBeVisible();
    const banner = page.getByRole('banner');
    await expect(banner.getByRole('button', { name: /^Search everything/ })).toBeVisible();
    await expect(banner.getByRole('button', { name: /^Notifications/ })).toBeVisible();
    await expect(banner.getByRole('button', { name: 'Quick settings' })).toBeVisible();
    // A provider is connected and nothing is wrong with the connection: no banner on the page.
    await expect(page.locator('.cinder-banner')).toHaveCount(0);
    await captureForDesignReview(page, {
      route: '/chats/:chat',
      state: 'thirty tool calls',
      source: SOURCE,
    });
  });

  test('keeps the chat list at 250px beside the conversation, with its search, days and rows (21p)', async ({
    page,
    request,
  }) => {
    await openLongTurn(page, request);
    const list = chatList(page);
    const box = await list.boundingBox();
    expect(box?.width).toBe(LIST_WIDTH);
    const conversation = await openChat(page).boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual((conversation?.x ?? 0) + 1);

    await expect(list.getByRole('searchbox', { name: 'Search chats' })).toBeVisible();
    // At 250px the three status segments no longer fit on one line, so the frame draws none.
    await expect(list.getByRole('radiogroup', { name: 'Status' })).toHaveCount(0);
    await expect(list.locator('.cinder-data-list-group__header')).toHaveText([
      /^Today\s*Central time$/,
      /^Yesterday, Sunday, Nov 1\s*Central time$/,
      /^Thursday, Oct 29\s*Central time$/,
    ]);
    const parcelly = chatRow(page, TOOL_CALL_TURN_TITLE);
    await expect(parcelly).toContainText('9:52 AM');
    await expect(parcelly).toContainText('Waiting on you');
    await expect(parcelly).toContainText(TOOL_CALL_TURN_QUESTION);
    await expect(parcelly.getByRole('link')).toHaveAttribute('aria-current', 'true');
    // The selected row is tinted; the others are not.
    // The row's own surface: the first background at or above it that is not transparent.
    const tint = (row: Locator) =>
      row.evaluate((element) => {
        for (let node: Element | null = element; node !== null; node = node.parentElement) {
          const color = getComputedStyle(node).backgroundColor;
          if (color !== 'rgba(0, 0, 0, 0)') return color;
        }
        return 'rgba(0, 0, 0, 0)';
      });
    const others = [REFUND, 'Say hello', 'Rename the billing tables'];
    expect(await tint(parcelly)).not.toBe(await tint(chatRow(page, 'Say hello')));
    const refund = chatRow(page, REFUND);
    await expect(refund).toContainText('10:42 AM');
    await expect(refund).toContainText('Waiting on you');
    const hello = chatRow(page, 'Say hello');
    await expect(hello).toContainText('4:12 PM');
    await expect(hello).toContainText('Done');
    await expect(hello).toContainText('Hello! How can I help?');
    const billing = chatRow(page, 'Rename the billing tables');
    await expect(billing).toContainText('11:05 AM');
    await expect(billing).toContainText('Ended');
    await expect(billing).toContainText('The server restarted before I finished.');
    for (const title of others) await expect(chatRow(page, title)).toHaveCount(1);
    // The Runs board's Oct 30 chat is not in this frame's list.
    await expect(list).not.toContainText('Look up order 4468');
  });

  test('shows the heading and its status, the message, the reply, the summary and the rail (21q)', async ({
    page,
    request,
  }) => {
    await openLongTurn(page, request);
    const heading = page.getByRole('heading', { level: 1, name: TOOL_CALL_TURN_TITLE });
    await expect(heading).toBeVisible();
    await expect(heading.locator('..')).toContainText('Waiting on you');
    const status = heading.locator('..').locator('.cinder-status-dot').first();
    await expect(status).toHaveAttribute('data-cinder-status', 'warning');

    const conversation = openChat(page);
    const message = conversation.locator('.chat-message--user, [data-role="user"]').first();
    await expect(message).toContainText(TOOL_CALL_TURN_MESSAGE);
    await expect(message).toContainText('9:52 AM');
    await expect(message.getByRole('button', { name: /Branch/ })).toBeVisible();
    await expect(message.getByRole('button', { name: /Copy/ })).toBeVisible();
    await expect(
      conversation.getByText(
        'Checking the Parcelly damaged-carrier batch against the refund policy.',
        {
          exact: true,
        },
      ),
    ).toBeVisible();

    await expect(rail(page).locator('.cinder-tool-call-rail__summary')).toHaveText(
      /^\s*Used 30 tools,\s*1 failed,\s*1 waiting on you,\s*18s\s*$/,
    );
    // The rail: the first three calls, one fold of the twenty-four between, then the failed call,
    // the approved one and the one that waits.
    await expect(railRows(page)).toHaveCount(6);
    await expect(railRows(page).nth(0)).toContainText('Search orders');
    await expect(railRows(page).nth(1)).toContainText('Lookup order');
    await expect(railRows(page).nth(1)).toContainText('4471');
    await expect(railRows(page).nth(1)).toContainText('→ $42.00, delivered Mon');
    await expect(railRows(page).nth(2)).toContainText('4476');
    await expect(rail(page).locator('.cinder-tool-call-rail__more')).toHaveText('Show 24 more');
    await expect(railRows(page).nth(3)).toContainText('Send email');
    await expect(railRows(page).nth(3)).toContainText('→ SMTP timeout after 10s');
    await expect(railRows(page).nth(4)).toContainText('Approved by you 9:58 AM');
    await expect(railRows(page).nth(5)).toContainText('Waiting on you');
    // The approval is the waiting row's content, with Deny and Approve at its right.
    const approval = page.locator('[data-approval-decision]');
    await expect(approval.getByRole('heading', { level: 4 })).toHaveText(TOOL_CALL_TURN_QUESTION);
    await expect(approval.getByRole('button', { name: 'Deny' })).toBeVisible();
    await expect(approval.getByRole('button', { name: 'Approve' })).toBeVisible();
    // Nothing was answered by opening the chat.
    await expect(approval.getByRole('button', { name: 'Approve' })).toBeEnabled();
    await captureForDesignReview(page, {
      route: '/chats/:chat',
      state: 'thirty tool calls, whole conversation',
      source: SOURCE,
    });
  });
});

test.describe('the shipped turn display is B’s rail with E’s panel (21a, 21b, 21c)', () => {
  test('docks the failed call’s panel beside the conversation when its row is chosen, and closes it back to the row', async ({
    page,
    request,
  }) => {
    await openLongTurn(page, request);
    await rowOf(page, 'Send email').click();
    const panel = page.locator('.cinder-tool-call-panel');
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Send email');
    await expect(panel).toContainText('send-email');
    await expect(panel).toContainText('Failed');
    await expect(panel).toContainText('call 28 of 30');
    await expect(panel.getByText('maya@example.com')).toBeVisible();
    await expect(panel).toContainText('SMTP timeout after 10s');
    await expect(panel).toContainText('smtp-timeout');
    // Docked beside the conversation: about 340px wide, to the right of it, and the rail's row tinted.
    const box = await panel.boundingBox();
    expect(Math.round(box?.width ?? 0)).toBe(340);
    const conversation = await openChat(page).boundingBox();
    expect(box?.x ?? 0).toBeGreaterThanOrEqual(
      (conversation?.x ?? 0) + (conversation?.width ?? 0) - 400,
    );
    await expect(rowOf(page, 'Send email')).toHaveAttribute('aria-pressed', 'true');
    // The rows stay one line each: nothing in the rail opened under a row.
    await expect(rail(page).locator('.ib-tool__details')).toHaveCount(0);
    await captureForDesignReview(page, {
      route: '/chats/:chat',
      state: 'thirty tool calls, failed call panel',
      source: SOURCE,
    });
    await panel.getByRole('button', { name: 'Close panel' }).click();
    await expect(panel).toHaveCount(0);
    await expect(rowOf(page, 'Send email')).toBeFocused();
  });

  test('is not a tree on edge: no level of the rail has a chevron but the summary and the fold, and no call expands in place (21a)', async ({
    page,
    request,
  }) => {
    await openLongTurn(page, request);
    // The summary line and the fold are the only disclosures on the rail.
    await expect(rail(page).locator('.cinder-tool-call-rail__summary[aria-expanded]')).toHaveCount(
      1,
    );
    await expect(rail(page).locator('.cinder-tool-call-rail__more[aria-expanded]')).toHaveCount(1);
    await expect(railRows(page).and(page.locator('[aria-expanded]'))).toHaveCount(0);
    await rowOf(page, 'Send email').click();
    await expect(rail(page).locator('dl')).toHaveCount(0);
    await expect(rail(page)).not.toContainText('Template');
    // Opening the fold lists every call, all thirty, in the order they ran, still one line each.
    await rail(page).locator('.cinder-tool-call-rail__more').click();
    await expect(railRows(page)).toHaveCount(TOOL_CALL_TURN_CALLS);
  });

  test('is not grouped by tool: no chips, no count per kind, no "Show all" (21b), and time order is kept on the rail', async ({
    page,
    request,
  }) => {
    await openLongTurn(page, request);
    await expect(page.getByText(/9 kinds/)).toHaveCount(0);
    await expect(page.getByText(/Showing .* only/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Show all/ })).toHaveCount(0);
    await expect(rail(page).locator('.cinder-chip, [data-cinder-chip]')).toHaveCount(0);
    await rail(page).locator('.cinder-tool-call-rail__more').click();
    const shown = await railRows(page).evaluateAll((rows) =>
      rows.map((row) => row.querySelector('.cinder-tool-call-rail__name')?.textContent?.trim()),
    );
    // A call's state is written before its name for a screen reader ("Failed: Send email").
    const names = shown.map((name) => name?.replace(/^(Failed|Approved|Denied|Interrupted): /, ''));
    expect(names).toHaveLength(TOOL_CALL_TURN_CALLS);
    // Time order: the search first, the lookups together, the inventory checks, the customers, and
    // the refunds last, whatever the tool.
    expect(names.slice(0, 2)).toEqual(['Search orders', 'Lookup order']);
    expect(names.slice(-3)).toEqual(['Send email', 'Issue refund', 'Issue refund']);
    expect(names.indexOf('Check inventory')).toBeGreaterThan(names.lastIndexOf('Lookup order'));
    expect(names.indexOf('Lookup customer')).toBeGreaterThan(names.lastIndexOf('Check inventory'));
  });

  test('is not a table: no columns for the tool, key input, result, status and duration (21c)', async ({
    page,
    request,
  }) => {
    await openLongTurn(page, request);
    await rail(page).locator('.cinder-tool-call-rail__more').click();
    await expect(openChat(page).getByRole('table')).toHaveCount(0);
    await expect(openChat(page).getByRole('columnheader')).toHaveCount(0);
    await expect(openChat(page).getByText('Key input', { exact: true })).toHaveCount(0);
    // One line per call, never wrapped: every row is as tall as the first.
    const heights = await railRows(page).evaluateAll((rows) =>
      rows.map((row) => Math.round(row.getBoundingClientRect().height)),
    );
    expect(new Set(heights).size).toBeLessThanOrEqual(2);
    expect(Math.max(...heights)).toBeLessThanOrEqual(48);
  });
});
