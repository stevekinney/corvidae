/**
 * The side panel of a turn's tool call (COR-2016, design rows 21q and 21o): choosing a call's row
 * opens what it was given and what it answered beside the transcript, choosing it again or closing
 * the panel puts it away, and closing hands focus back to the row that opened it.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import ChatConversation from './chat-conversation.svelte';
import ChatToasts from './chat-toasts.test-harness.svelte';
import { bureau, CONTEXT, landAt, loadedComposer } from './pages.test-support.ts';

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  restore?.();
  restore = undefined;
});

const sse = (events: readonly unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });

/** A run that looks an order up, gets an answer and replies. */
function lookupRun(url: string, init?: RequestInit): Response | undefined {
  if (url.endsWith('/messages')) return Response.json({ threadId: 'session-1', messages: [] });
  if (url.includes('/threads/')) {
    return sse([{ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' }]);
  }
  if (!url.includes('/agents/')) return undefined;
  const input: { runId: string } = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
  return sse([
    { type: 'RUN_STARTED', threadId: 'session-1', runId: input.runId },
    { type: 'TOOL_CALL_START', toolCallId: 'call-lookup', toolCallName: 'lookup-order' },
    { type: 'TOOL_CALL_ARGS', toolCallId: 'call-lookup', delta: '{"orderId":"4471"}' },
    { type: 'TOOL_CALL_END', toolCallId: 'call-lookup' },
    {
      type: 'TOOL_CALL_RESULT',
      messageId: 'result-1',
      toolCallId: 'call-lookup',
      content: '{"total":"$42.00"}',
      role: 'tool',
    },
    { type: 'TOOL_CALL_START', toolCallId: 'call-missing', toolCallName: 'lookup-order' },
    { type: 'TOOL_CALL_ARGS', toolCallId: 'call-missing', delta: '{"orderId":"0000"}' },
    { type: 'TOOL_CALL_END', toolCallId: 'call-missing' },
    {
      type: 'TOOL_CALL_RESULT',
      messageId: 'result-2',
      toolCallId: 'call-missing',
      content: JSON.stringify({
        outcome: 'error',
        content: null,
        error: { message: 'No such order', code: 'not_found' },
      }),
      role: 'tool',
    },
    { type: 'TOOL_CALL_START', toolCallId: 'call-third', toolCallName: 'lookup-order' },
    { type: 'TOOL_CALL_ARGS', toolCallId: 'call-third', delta: '{"orderId":"4472"}' },
    { type: 'TOOL_CALL_END', toolCallId: 'call-third' },
    {
      type: 'TOOL_CALL_RESULT',
      messageId: 'result-3',
      toolCallId: 'call-third',
      content: '{"total":"$7.50"}',
      role: 'tool',
    },
    { type: 'TEXT_MESSAGE_START', messageId: 'reply-1', role: 'assistant' },
    { type: 'TEXT_MESSAGE_CONTENT', messageId: 'reply-1', delta: 'Order 4471 is $42.00.' },
    { type: 'TEXT_MESSAGE_END', messageId: 'reply-1' },
    { type: 'RUN_FINISHED', threadId: 'session-1', runId: input.runId },
  ]);
}

async function lookedUp() {
  restore = bureau(
    { 'bureau.contexts.get': () => CONTEXT, 'bureau.reviews.list': () => ({ reviews: [] }) },
    lookupRun,
  ).restore;
  landAt('/chats/session-1');
  const view = render(ChatToasts, {
    props: {
      page: ChatConversation,
      pageProps: { sessionId: 'session-1', title: 'Plan the week', agentName: 'assistant' },
    },
  } as never);
  const box = await loadedComposer(view.container);
  await fireEvent.input(box, { target: { value: 'Look up 4471' } });
  await fireEvent.keyDown(box, { key: 'Enter' });
  const row = await waitFor(() => {
    const found = view.container.querySelector<HTMLElement>(
      '[data-cinder-tool-call-row="call-lookup"]',
    );
    expect(found).not.toBeNull();
    return found as HTMLElement;
  });
  return { ...view, row };
}

describe('a tool call’s side panel', () => {
  test('opens on the chosen row with what the call was given, and chosen again puts it away', async () => {
    const { container, row } = await lookedUp();
    expect(container.querySelector('.ib-chat-panel')).toBeNull();

    await fireEvent.click(row);
    await waitFor(() => expect(container.querySelector('.ib-chat-panel')).not.toBeNull());
    const panel = container.querySelector('.ib-chat-panel');
    expect(panel?.textContent).toContain('Lookup order');
    expect(panel?.textContent).toContain('4471');

    await fireEvent.click(row);
    await waitFor(() => expect(container.querySelector('.ib-chat-panel') === null).toBe(true));
  });

  test('shows what a call answered, what another answered, and its place among the turn’s calls', async () => {
    const { container, row } = await lookedUp();

    await fireEvent.click(row);
    await waitFor(() => expect(container.querySelector('.ib-chat-panel')).not.toBeNull());
    await waitFor(() =>
      expect(container.querySelector('.ib-chat-panel')?.textContent).toContain('$42.00'),
    );

    const failed = await waitFor(() => {
      const found = container.querySelector<HTMLElement>(
        '[data-cinder-tool-call-row="call-missing"]',
      );
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    await fireEvent.click(failed);
    await waitFor(() =>
      expect(container.querySelector('.ib-chat-panel')?.textContent).toContain('No such order'),
    );
    // The panel says where the call stands among the turn’s calls.
    expect(container.querySelector('.ib-chat-panel')?.textContent).toContain('call 2 of 2');
  });

  test('closing it hands focus back to the row that opened it', async () => {
    const { container, row } = await lookedUp();

    await fireEvent.click(row);
    await waitFor(() => expect(container.querySelector('.ib-chat-panel')).not.toBeNull());
    // Narrow, the panel is a drawer; docked, it is an aside with its own close button.
    const close = document.querySelector<HTMLElement>(
      '.cinder-drawer__close, [aria-label="Close panel"]',
    );
    if (close === null) throw new Error('The panel has no close button.');
    await fireEvent.click(close);

    await waitFor(() => expect(container.querySelector('.ib-chat-panel') === null).toBe(true));
    await waitFor(() => expect(document.activeElement === row).toBe(true));
  });

  test('sums three or more calls into one line under the turn', async () => {
    const { container } = await lookedUp();

    await waitFor(() =>
      expect(container.querySelector('.cinder-tool-call-rail__summary')?.textContent).toContain(
        'Used 3 tools',
      ),
    );
  });
});
