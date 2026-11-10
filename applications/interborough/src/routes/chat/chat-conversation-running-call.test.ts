/**
 * A tool call that is still running (COR-2016, design row 21q): its row says it is running and its
 * clock keeps counting while the call has no answer, so the panel's "Running · 0.0s" moves on.
 */
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, expect, jest, test } from 'bun:test';

import { settle, until } from '../../lib/fake-timers.test-support.ts';
import ChatConversation from './chat-conversation.svelte';
import { bureau, CONTEXT, landAt } from './pages.test-support.ts';
import QueryPage from './query-page.test-harness.svelte';

let restore: (() => void) | undefined;
afterEach(() => {
  cleanup();
  jest.useRealTimers();
  restore?.();
  restore = undefined;
});

/** A run that starts a call and never answers it: its stream stays open. */
function slowRun(url: string, init?: RequestInit): Response | undefined {
  if (url.endsWith('/messages')) return Response.json({ threadId: 'session-1', messages: [] });
  if (url.includes('/threads/')) {
    return new Response(
      `data: ${JSON.stringify({ type: 'RUN_ERROR', message: 'none', code: 'RUN_NOT_FOUND' })}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    );
  }
  if (!url.includes('/agents/')) return undefined;
  const input: { runId: string } = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
  const frames = [
    { type: 'RUN_STARTED', threadId: 'session-1', runId: input.runId },
    { type: 'TOOL_CALL_START', toolCallId: 'call-slow', toolCallName: 'lookup-order' },
    { type: 'TOOL_CALL_ARGS', toolCallId: 'call-slow', delta: '{"orderId":"4471"}' },
    { type: 'TOOL_CALL_END', toolCallId: 'call-slow' },
  ];
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`));
        }
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

test('a running call’s clock keeps counting while it has no answer', async () => {
  restore = bureau(
    { 'bureau.contexts.get': () => CONTEXT, 'bureau.reviews.list': () => ({ reviews: [] }) },
    slowRun,
  ).restore;
  landAt('/chats/session-1');
  jest.useFakeTimers();
  const { container } = render(QueryPage, {
    props: {
      page: ChatConversation,
      pageProps: { sessionId: 'session-1', title: 'Plan the week', agentName: 'assistant' },
    },
  } as never);
  await until(() => expect(container.querySelector('textarea')).not.toBeNull());
  const box = container.querySelector('textarea') as HTMLTextAreaElement;
  await fireEvent.input(box, { target: { value: 'Look up 4471' } });
  await fireEvent.keyDown(box, { key: 'Enter' });
  await until(() =>
    expect(container.querySelector('[data-cinder-tool-call-row="call-slow"]')).not.toBeNull(),
  );
  await fireEvent.click(
    container.querySelector('[data-cinder-tool-call-row="call-slow"]') as HTMLElement,
  );
  await until(() => expect(container.querySelector('.ib-chat-panel')).not.toBeNull());
  const before = container.querySelector('.ib-chat-panel')?.textContent ?? '';

  jest.advanceTimersByTime(5_000);
  await settle(4);

  expect(container.querySelector('.ib-chat-panel')?.textContent).not.toBe(before);
});
