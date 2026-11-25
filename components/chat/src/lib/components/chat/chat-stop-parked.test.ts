/** A paused approval is still a run, so its compact composer exposes the real Stop action. */

/// <reference lib="dom" />
import { afterAll, afterEach, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';
import {
  appendToolCall,
  appendToolResult,
  appendUserMessage,
  createConversationHistory,
} from './builders.ts';

setupHappyDom();

class TestResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
const originalResizeObserver = globalThis.ResizeObserver;
globalThis.ResizeObserver = TestResizeObserver;

class TestIntersectionObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}
const originalIntersectionObserver = globalThis.IntersectionObserver;
globalThis.IntersectionObserver =
  TestIntersectionObserver as unknown as typeof IntersectionObserver;
afterAll(() => {
  globalThis.ResizeObserver = originalResizeObserver;
  globalThis.IntersectionObserver = originalIntersectionObserver;
});

const { cleanup, fireEvent, render } = await import('@testing-library/svelte');
const { default: Chat } = await import('./chat.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

test('renders Stop for a parked approval and routes it to the host', async () => {
  const conversation = appendToolResult(
    appendToolCall(
      appendUserMessage(createConversationHistory({ id: 'parked-approval' }), 'Refund order 4471'),
      { id: 'refund', name: 'issue-refund', arguments: { orderId: '4471' } },
    ),
    {
      callId: 'refund',
      outcome: 'action_required',
      content: null,
      action: {
        type: 'approval',
        message: 'Refund order 4471?',
        risk: 'high',
        operation: { kind: 'other', argsPreview: { orderId: '4471' } },
        policyVersion: 'test-policy',
        idempotencyKey: 'refund-4471',
      },
    },
  );
  const stopped: string[] = [];
  const { container } = render(Chat, {
    id: 'chat-stop-parked',
    conversation,
    composerCompact: true,
    adapter: {
      sendMessage: async () => undefined,
      stopGenerating: async (messageId) => {
        stopped.push(messageId);
      },
    },
  });

  const stop = container.querySelector<HTMLButtonElement>('button[aria-label="Stop generating"]');
  expect(stop).not.toBeNull();
  expect(container.querySelector('button[aria-label="Send message"]')).toBeNull();

  await fireEvent.click(stop!);

  expect(stopped).toEqual([conversation.ids.at(-1)!]);
});
