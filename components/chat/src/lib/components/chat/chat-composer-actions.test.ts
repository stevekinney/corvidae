/**
 * `composerActions`: host-owned controls rendered in the composer footer.
 *
 * Asserts:
 *   1. Without the snippet, the composer footer renders exactly as before.
 *   2. With it, the snippet renders in ChatInput's actions slot, beside Send.
 *   3. The controls stay usable while a run streams and while a tool approval
 *      is pending, including with follow-ups switched on.
 */

/// <reference lib="dom" />
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { createRawSnippet } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';
import type { ChatAdapter } from './adapter/chat-adapter.ts';
import {
  appendAssistantMessage,
  appendToolCall,
  appendToolResult,
  appendUserMessage,
  createConversationHistory,
} from './builders.ts';
import type { ConversationHistory } from './conversation-model.ts';

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

const { render, fireEvent, cleanup } = await import('@testing-library/svelte');
const { default: Chat } = await import('./chat.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const modelPicker = createRawSnippet(() => ({
  render: () =>
    '<select aria-label="Model" data-testid="model-picker"><option value="fast">Fast</option><option value="deep">Deep</option></select>',
}));

function footerRight(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>('.chat-input-footer-right')!;
}

function approvalConversation(id: string): ConversationHistory {
  return appendToolResult(
    appendToolCall(appendUserMessage(createConversationHistory({ id }), 'write it'), {
      id: 'call',
      name: 'write',
      arguments: {},
    }),
    {
      callId: 'call',
      outcome: 'action_required',
      content: null,
      action: {
        type: 'approval',
        message: 'Approve this tool call',
        risk: 'high',
        operation: { kind: 'command', command: 'echo approval', argsPreview: {} },
        policyVersion: 'test-policy',
        idempotencyKey: 'test-approval',
      },
    },
  );
}

describe('Chat composerActions', () => {
  test('renders the composer footer as before when the snippet is omitted', () => {
    const { container } = render(Chat, {
      id: 'chat-no-actions',
      conversation: createConversationHistory({ id: 'no-actions' }),
    });

    const right = footerRight(container);
    // Nothing precedes Send: the actions slot is empty.
    expect(right.firstElementChild?.getAttribute('aria-label')).toBe('Send message');
    expect(container.querySelector('[data-testid="model-picker"]')).toBeNull();
  });

  test('renders the snippet in the composer actions slot, before Send', () => {
    const { container } = render(Chat, {
      id: 'chat-actions',
      conversation: createConversationHistory({ id: 'actions' }),
      composerActions: modelPicker,
    });

    const right = footerRight(container);
    const picker = right.querySelector('[data-testid="model-picker"]');
    const send = right.querySelector('button[aria-label="Send message"]');
    expect(picker).not.toBeNull();
    expect(send).not.toBeNull();
    expect(picker!.compareDocumentPosition(send!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  test('keeps the controls usable while a run streams', async () => {
    const conversation = appendAssistantMessage(
      appendUserMessage(createConversationHistory({ id: 'streaming-actions' }), 'hi'),
      'working',
    );
    const { container } = render(Chat, {
      id: 'chat-streaming-actions',
      conversation,
      streaming: true,
      composerActions: modelPicker,
    });

    const picker = container.querySelector<HTMLSelectElement>('[data-testid="model-picker"]')!;
    expect(picker.disabled).toBe(false);
    expect(picker.closest('[inert]')).toBeNull();
    let changes = 0;
    picker.addEventListener('change', () => (changes += 1));
    picker.value = 'deep';
    await fireEvent.change(picker);
    expect(changes).toBe(1);
    expect(picker.value).toBe('deep');
  });

  test('keeps the controls usable while a run streams with follow-ups switched on', () => {
    const adapter: ChatAdapter = {
      sendMessage: async () => undefined,
      sendRunInput: async () => undefined,
    };
    const { container } = render(Chat, {
      id: 'chat-follow-up-actions',
      conversation: createConversationHistory({ id: 'follow-up-actions' }),
      streaming: true,
      adapter,
      composerActions: modelPicker,
    });

    const right = footerRight(container);
    expect(right.querySelector<HTMLSelectElement>('[data-testid="model-picker"]')?.disabled).toBe(
      false,
    );
    expect(right.querySelector('button[aria-label="Send message"]')).not.toBeNull();
    expect(right.querySelector('button[aria-label="Stop generating"]')).not.toBeNull();
  });

  test('keeps the controls usable while a tool approval is pending', async () => {
    const { container } = render(Chat, {
      id: 'chat-approval-actions',
      conversation: approvalConversation('approval-actions'),
      composerActions: modelPicker,
    });

    const picker = container.querySelector<HTMLSelectElement>('[data-testid="model-picker"]')!;
    expect(picker.disabled).toBe(false);
    picker.value = 'deep';
    await fireEvent.change(picker);
    expect(picker.value).toBe('deep');
    // The approval is still waiting on the user.
    expect(container.textContent).toContain('Approve this tool call');
  });
});
