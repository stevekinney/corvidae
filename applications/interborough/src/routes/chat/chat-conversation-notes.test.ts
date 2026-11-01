/**
 * The lines a run leaves under a chat's messages, on the conversation page: what a reloaded chat
 * says of its last run, what it stored, and what a live run announced, with a link that opens its
 * page inside the application.
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
  finishReason: 'budget-exceeded',
  statusMessage: 'Budget exceeded: max calls 1',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:01.000Z',
  cleanup: null,
  openWaits: [],
};

describe('a chat opened again', () => {
  const messages = [
    { id: 'u1', role: 'user', content: 'Remember my name' },
    {
      id: 'a1',
      role: 'assistant',
      content: 'Saving it.',
      toolCalls: [
        { id: 'call-1', type: 'function', function: { name: 'memory_store', arguments: '{}' } },
      ],
    },
    {
      id: 'tool-1',
      role: 'tool',
      toolCallId: 'call-1',
      content: JSON.stringify({
        stored: true,
        id: 'rec-1',
        collection: 'preferences',
        memoryClass: 'semantic',
      }),
    },
    { id: 'a2', role: 'assistant', content: 'Saved.' },
  ];

  function open() {
    restore = bureau(
      {
        'bureau.contexts.get': () => CONTEXT,
        'bureau.tasks.list': () => ({ tasks: [task], nextPageToken: null }),
      },
      (url) => {
        if (url.endsWith('/messages')) return Response.json({ threadId: 'session-1', messages });
        if (url.includes('/threads/')) {
          return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
        }
        return undefined;
      },
    ).restore;
    landAt('/chats/session-1');
    return mount({ sessionId: 'session-1', title: 'Plan the week', agentName: 'assistant' });
  }

  test('says why its last run stopped', async () => {
    const { findByText } = open();

    const reason = await findByText('Budget exceeded: max calls 1');
    expect(reason.closest('[data-kind="stopped"]')?.textContent).toContain('Stopped');
  });

  test('says what the agent remembered, and the link opens its memory without leaving the app', async () => {
    const { findByText, container } = open();

    await findByText('Remembered');
    const link = container.querySelector<HTMLAnchorElement>('a[data-chat-note-link]');
    expect(link?.getAttribute('href')).toBe('/agents/assistant/memories');

    await fireEvent.click(link!);

    expect(window.location.pathname).toBe('/agents/assistant/memories');
  });
});

describe('a live run that only called a tool', () => {
  test('says when it will continue, with the tools it used', async () => {
    restore = bureau(
      {
        'bureau.agents.list': () => ({ agents: [] }),
        'bureau.contexts.get': () => ({ ...CONTEXT, id: 'thread-1' }),
      },
      (url, init) => {
        if (!url.includes('/ag-ui/agents/')) return undefined;
        const body = typeof init?.body === 'string' ? init.body : '{}';
        const input: { threadId: string; runId: string } = JSON.parse(body);
        return sse([
          { type: 'RUN_STARTED', threadId: input.threadId, runId: input.runId },
          {
            type: 'TOOL_CALL_START',
            toolCallId: 'c1',
            toolCallName: 'wait',
            parentMessageId: 's1',
          },
          { type: 'TOOL_CALL_ARGS', toolCallId: 'c1', delta: '{}' },
          { type: 'TOOL_CALL_END', toolCallId: 'c1' },
          {
            type: 'TOOL_CALL_RESULT',
            messageId: 'r1',
            toolCallId: 'c1',
            content: 'parked',
            role: 'tool',
          },
          {
            type: 'CUSTOM',
            name: 'bureau.wakeup-scheduled',
            value: {
              runId: 'native',
              duration: '6h',
              note: 'check the deploy',
              wakeAt: 1_900_000_000_000,
            },
          },
          {
            type: 'CUSTOM',
            name: 'bureau.child-run-started',
            value: { parentRunId: 'native', childRunId: 'child-1', childAgentName: 'researcher' },
          },
          {
            type: 'RUN_FINISHED',
            threadId: input.threadId,
            runId: input.runId,
            outcome: { type: 'success' },
          },
        ]);
      },
    ).restore;
    landAt('/chats/new');
    const { container, findByText } = mount({
      sessionId: 'thread-1',
      title: null,
      agentName: 'assistant',
      isNew: true,
    });
    const box = await waitFor(() => {
      const found = container.querySelector('textarea');
      if (found === null) throw new Error('The composer did not render.');
      return found;
    });

    await fireEvent.input(box, { target: { value: 'Wait for the deploy' } });
    await fireEvent.keyDown(box, { key: 'Enter' });

    await findByText('Will continue at');
    expect(container.textContent).toContain('check the deploy');
    expect(container.querySelector('[data-kind="child-run"]')?.textContent).toContain('researcher');
  });
});
