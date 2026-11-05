/**
 * A chat opened on a run that failed (COR-2014): the status beside the title reads Failed, the
 * rail shows the call the run ended on as interrupted in words that follow what its tool may do, the
 * status line says so in danger text with a Retry beside it, and Retry runs the turn again over a
 * fresh reply.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
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

const mount = (props: Record<string, unknown>) =>
  render(QueryPage, { props: { page: ChatConversation, pageProps: props } } as never);

const sse = (events: readonly unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });

const task = {
  id: 'task-1',
  contextId: 'session-1',
  agentName: 'assistant',
  owner: 'owner',
  actor: null,
  kind: 'chat',
  origin: { kind: 'chat' },
  status: 'failed',
  finishReason: null,
  statusMessage: 'The model provider dropped the connection.',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:01.000Z',
  cleanup: null,
  openWaits: [],
};

const catalog = (tier: 'read-only' | 'dangerous') => ({
  models: [],
  tools: [
    {
      name: 'issue-refund',
      description: 'Refunds an order',
      shortDescription: null,
      title: 'Issue refund',
      inputSchema: null,
      tier,
      defaultApproval: 'ask',
      source: 'host',
      plugin: null,
      skill: null,
      users: [],
    },
  ],
});

/** A chat whose last run stopped on a call of `issue-refund` that has no answer. */
function open(tier: 'read-only' | 'dangerous', started: string[] = []) {
  const messages = [
    { id: 'u1', role: 'user', content: 'Please refund order 4471, it arrived damaged.' },
    {
      id: 'a1',
      role: 'assistant',
      content: '',
      toolCalls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'issue-refund', arguments: '{"orderId":"4471"}' },
        },
      ],
    },
  ];
  restore = bureau(
    {
      'bureau.contexts.get': () => CONTEXT,
      'bureau.tasks.list': () => ({ tasks: [task], nextPageToken: null }),
      'bureau.agents.catalog': () => catalog(tier),
    },
    (url, init) => {
      if (url.endsWith('/messages')) return Response.json({ threadId: 'session-1', messages });
      if (url.includes('/threads/')) {
        return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
      }
      if (url.includes('/agents/')) {
        started.push(typeof init?.body === 'string' ? init.body : '');
        return sse([
          { type: 'RUN_STARTED', threadId: 'session-1', runId: 'run-2' },
          {
            type: 'RUN_FINISHED',
            threadId: 'session-1',
            runId: 'run-2',
            outcome: { type: 'success' },
          },
        ]);
      }
      return undefined;
    },
  ).restore;
  landAt('/chats/session-1');
  return mount({ sessionId: 'session-1', title: 'Refund', agentName: 'assistant' });
}

describe('a chat whose run failed on a call', () => {
  test('shows Failed beside the title', async () => {
    const { findByText } = open('dangerous');
    const status = await findByText('Failed');
    expect(status.closest('[data-testid="chat-header"]')).not.toBeNull();
  });

  test('says the call may have run, and that Retry goes back through the approval, for a tool that changes things', async () => {
    const { container, findByText } = open('dangerous');
    const line = await findByText(/The reply stopped while Issue refund was running/);
    expect(line.textContent).toContain('the model provider dropped the connection');
    expect(line.textContent).toContain('Issue refund may have run.');
    expect(line.textContent).toContain('Retry goes back through the approval.');
    expect(line.textContent?.toLowerCase()).not.toContain('nothing was changed');
    await waitFor(() =>
      expect(
        container.querySelector('.cinder-tool-call-rail__item[data-cinder-status="interrupted"]')
          ?.textContent,
      ).toContain('Interrupted · may have run'),
    );
  });

  test('says the call did not finish and nothing was changed for a tool that only reads', async () => {
    const { container, findByText } = open('read-only');
    const line = await findByText(/The reply stopped while Issue refund was running/);
    expect(line.textContent).toContain('Issue refund didn’t finish and nothing was changed.');
    await waitFor(() =>
      expect(
        container.querySelector('.cinder-tool-call-rail__item[data-cinder-status="interrupted"]')
          ?.textContent,
      ).toContain('Interrupted · didn’t finish'),
    );
  });

  test('Retry sends the message again over a fresh reply and never resumes the call', async () => {
    const started: string[] = [];
    const { container, findByRole } = open('dangerous', started);
    await findByRole('button', { name: 'Retry' });

    await fireEvent.click(await findByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(started).toHaveLength(1));
    expect(started[0]).toContain('Please refund order 4471, it arrived damaged.');
    expect(started[0]).not.toContain('call-1');
    await waitFor(() =>
      expect(container.querySelector('[data-cinder-status="interrupted"]')).toBeNull(),
    );
  });
});
