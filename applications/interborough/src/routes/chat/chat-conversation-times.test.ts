/**
 * The times, models and durations a chat shows are the Bureau's (COR-2014, rows 16j, 16k, 19x and
 * 20a): each message at the time the Bureau wrote it, each reply under the model that wrote it and
 * not the one the chat runs on now, and each call's duration from the start and end the Bureau
 * recorded, or to when the run stopped for a call it left without an answer.
 */
import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import ChatConversation from './chat-conversation.svelte';
import { bureau, CONTEXT, landAt } from './pages.test-support.ts';
import QueryPage from './query-page.test-harness.svelte';

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

const CREATED_AT = 'conversationalist:createdAt';
const at = (time: string) => `2026-11-02T${time}Z`;
const shortTime = (iso: string) =>
  new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

const USER_AT = at('16:41:00.000');
const REPLY_AT = at('16:42:00.000');

const mount = () =>
  render(QueryPage, {
    props: {
      page: ChatConversation,
      pageProps: { sessionId: 'session-1', title: 'Refund', agentName: 'tool-runner' },
    },
  } as never);

const catalog = {
  models: [],
  tools: [
    {
      name: 'lookup-order',
      description: 'Looks an order up',
      shortDescription: null,
      title: 'Lookup order',
      inputSchema: null,
      tier: 'read-only',
      defaultApproval: 'never',
      source: 'host',
      plugin: null,
      skill: null,
      users: [],
    },
  ],
};

/** A thread the Bureau answers with `messages`, whose last run is `task` (or none). */
function open(messages: readonly unknown[], task?: Record<string, unknown>) {
  restore = bureau(
    {
      // The chat runs on Haiku now; its reply was written by Sonnet.
      'bureau.contexts.get': () => ({
        ...CONTEXT,
        agentName: 'tool-runner',
        model: { provider: 'anthropic', model: 'claude-haiku-5-5' },
      }),
      'bureau.agents.models': () => ({
        selectable: true,
        models: [
          { provider: 'anthropic', model: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5' },
          { provider: 'anthropic', model: 'claude-haiku-5-5', displayName: 'Claude Haiku 5.5' },
        ],
        default: { provider: 'anthropic', model: 'claude-haiku-5-5' },
      }),
      'bureau.tasks.list': () => ({ tasks: task === undefined ? [] : [task], nextPageToken: null }),
      'bureau.tasks.inspect': () => ({ steps: [] }),
      'bureau.agents.catalog': () => catalog,
    },
    (url) => {
      if (url.endsWith('/messages')) return Response.json({ threadId: 'session-1', messages });
      if (url.includes('/threads/')) {
        return new Response(
          `data: ${JSON.stringify({ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return undefined;
    },
  ).restore;
  landAt('/chats/session-1');
  return mount();
}

const lookup = (createdAt: string) => ({
  id: 'run-1:step:0',
  role: 'assistant',
  content: '',
  toolCalls: [
    {
      id: 'call-1',
      type: 'function',
      function: { name: 'lookup-order', arguments: '{"orderId":"4471"}' },
      metadata: { [CREATED_AT]: createdAt },
    },
  ],
});

describe('a chat read from the Bureau', () => {
  test('shows each message at its recorded time, the reply under its own model, and the call’s recorded duration', async () => {
    const { container, findByText } = open([
      {
        id: 'u1',
        role: 'user',
        content: 'Please refund order 4471, it arrived damaged.',
        metadata: { [CREATED_AT]: USER_AT },
      },
      lookup(at('16:41:01.000')),
      {
        id: 'run-1:step:0:result:call-1',
        role: 'tool',
        toolCallId: 'call-1',
        content: '$42.00, delivered Monday, flagged damaged',
        metadata: {
          [CREATED_AT]: at('16:41:09.000'),
          toolTiming: { startedAt: at('16:41:05.000'), endedAt: at('16:41:05.400') },
        },
      },
      {
        id: 'run-1:step:1',
        role: 'assistant',
        content: 'Order 4471 is $42.00, delivered Monday.',
        metadata: {
          [CREATED_AT]: REPLY_AT,
          'bureau:replyModel': { provider: 'anthropic', model: 'claude-sonnet-5-5' },
        },
      },
    ]);
    await findByText('Order 4471 is $42.00, delivered Monday.');
    await waitFor(() =>
      expect(container.querySelector('.weft-chat-model')?.textContent).toBe('· Claude Sonnet 5.5'),
    );
    const times = [...container.querySelectorAll('time')].map((time) => [
      time.getAttribute('datetime'),
      time.textContent,
    ]);
    expect(times).toContainEqual([USER_AT, shortTime(USER_AT)]);
    expect(times).toContainEqual([REPLY_AT, shortTime(REPLY_AT)]);
    expect(container.querySelector('.cinder-tool-call-rail__duration')?.textContent).toBe('0.4s');
  });

  test('names no model for a reply whose row records none, rather than the chat’s', async () => {
    const { container, findByText } = open([
      { id: 'u1', role: 'user', content: 'Hello', metadata: { [CREATED_AT]: USER_AT } },
      {
        id: 'run-1:step:0',
        role: 'assistant',
        content: 'Hello there.',
        metadata: { [CREATED_AT]: REPLY_AT },
      },
    ]);
    await findByText('Hello there.');
    expect(container.querySelector('.weft-chat-model')).toBeNull();
  });

  test('counts a call the failed run left without an answer to when the run stopped', async () => {
    const { container } = open(
      [
        {
          id: 'u1',
          role: 'user',
          content: 'Please refund order 4471, it arrived damaged.',
          metadata: { [CREATED_AT]: USER_AT },
        },
        lookup(at('16:41:04.000')),
      ],
      {
        id: 'run-1',
        contextId: 'session-1',
        agentName: 'tool-runner',
        owner: 'owner',
        actor: null,
        kind: 'chat',
        origin: { kind: 'chat' },
        status: 'failed',
        finishReason: null,
        statusMessage: 'The model provider dropped the connection.',
        createdAt: at('16:41:00.000'),
        updatedAt: at('16:41:05.200'),
        cleanup: null,
        openWaits: [],
      },
    );
    await waitFor(() =>
      expect(
        container.querySelector(
          '.cinder-tool-call-rail__item[data-cinder-status="interrupted"] .cinder-tool-call-rail__duration',
        )?.textContent,
      ).toBe('1.2s'),
    );
  });
});
