/**
 * What the chat specs that draw a state the sample world does not hold share
 * (`chat-states.spec.ts`, `chat-new-workflows.spec.ts`): the host's provider list answered as it
 * would with a key in place, and a chat from `fixtures/chat-states.ts` opened by answering the
 * Bureau's own operations with the records such a chat would have.
 */
import type { APIRequestContext, Page, Route } from '@playwright/test';

import {
  contextOf,
  messagesOf,
  STATES_CONTEXT_WINDOW,
  tasksOf,
  threadOf,
  type StatesChat,
} from '../../fixtures/chat-states.ts';
import { SAMPLE_NOW } from '../../fixtures/sample-now.ts';
import { SAMPLE_WORLD_THREADS } from '../../fixtures/sample-world-records.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect } from './fixtures.ts';

/** Answers the host's provider list as it would with a key in place. */
export async function connectProvider(page: Page): Promise<void> {
  await page.route('**/host/providers', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { providers: { hasKey: boolean }[] };
    await route.fulfill({
      response,
      json: {
        ...body,
        providers: body.providers.map((provider) => ({ ...provider, hasKey: true })),
      },
    });
  });
}

/** What a request to the Bureau's JSON-RPC mount asks. */
interface Operation {
  readonly method?: string;
  readonly id?: unknown;
  readonly params?: { readonly contextId?: string };
}

const operationOf = (route: Route): Operation =>
  JSON.parse(route.request().postData() ?? '{}') as Operation;

/** Opens `path` at 1280 pixels on the sample clock (or at `now`) and waits until the page holds its state. */
export async function open(
  page: Page,
  path: string,
  now: string | number = SAMPLE_NOW,
): Promise<void> {
  await page.clock.setFixedTime(now);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(path);
}

/**
 * Opens one of the board's chats the sample world does not hold: the Bureau answers for its record,
 * its thread and its runs as it would for a chat it held, and the run it would attach to is not
 * there, which is how a chat answers once its run is no longer live.
 */
export async function openStatesChat(
  page: Page,
  request: APIRequestContext,
  chat: StatesChat,
  now: string | number = SAMPLE_NOW,
): Promise<void> {
  const read = await request.post(`${E2E_SHOWCASE_URL}/bureau/jsonrpc`, {
    data: {
      jsonrpc: '2.0',
      id: 1,
      method: 'bureau.contexts.get',
      params: { contextId: SAMPLE_WORLD_THREADS.refund },
    },
  });
  const kind = ((await read.json()) as { result: Record<string, unknown> }).result;
  const thread = threadOf(chat);
  const context = contextOf(chat, kind);
  await page.route('**/bureau/jsonrpc', async (route) => {
    const body = operationOf(route);
    if (body.params?.contextId !== thread) {
      await route.fallback();
      return;
    }
    if (body.method === 'bureau.contexts.get') {
      await route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result: context } });
      return;
    }
    if (body.method === 'bureau.contexts.window') {
      await route.fulfill({
        json: { jsonrpc: '2.0', id: body.id, result: STATES_CONTEXT_WINDOW },
      });
      return;
    }
    if (body.method === 'bureau.tasks.list') {
      await route.fulfill({
        json: {
          jsonrpc: '2.0',
          id: body.id,
          result: { tasks: tasksOf(chat), nextPageToken: null },
        },
      });
      return;
    }
    await route.fallback();
  });
  await page.route(`**/ag-ui/threads/${thread}/messages`, (route) =>
    route.fulfill({ json: { threadId: thread, messages: messagesOf(chat) } }),
  );
  await page.route(`**/ag-ui/threads/${thread}/run`, (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' })}\n\n`,
    }),
  );
  await open(page, `/chats/${thread}`, now);
  await expect(page.locator('[data-view="chat"]')).toHaveAttribute('data-state', 'ready');
}
