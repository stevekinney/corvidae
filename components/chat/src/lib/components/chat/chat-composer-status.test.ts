/**
 * The composer status line and the one-row approval, as Chat wires them: a
 * pending approval shows "Waiting for your approval" until it is resolved, the
 * host's own status wins, and the row's Approve and Deny reach the adapter.
 */

/// <reference lib="dom" />
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { tick } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';
import type { ChatAdapter } from './adapter/chat-adapter.ts';
import {
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

const { render, fireEvent, cleanup, getByRole } = await import('@testing-library/svelte');
const { default: Chat } = await import('./chat.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function approvalConversation(id: string): ConversationHistory {
  return appendToolResult(
    appendToolCall(appendUserMessage(createConversationHistory({ id }), 'refund it'), {
      id: 'call',
      name: 'issue-refund',
      arguments: { orderId: '4471' },
    }),
    {
      callId: 'call',
      outcome: 'action_required',
      content: null,
      action: {
        type: 'approval',
        message: 'Run issue-refund for $42.10?',
        risk: 'medium',
        operation: { kind: 'other', argsPreview: { orderId: '4471' } },
        policyVersion: 'test-policy',
        idempotencyKey: 'test-approval',
      },
    },
  );
}

function statusLine(container: HTMLElement): string | undefined {
  return container.querySelector('.chat-input-status')?.textContent ?? undefined;
}

describe('Chat composer status and approval row', () => {
  test('shows no status line when nothing is waiting', () => {
    const { container } = render(Chat, {
      id: 'chat-status-idle',
      conversation: appendUserMessage(createConversationHistory({ id: 'idle' }), 'hi'),
    });

    expect(statusLine(container)).toBeUndefined();
  });

  test('a pending approval shows waiting, and steering when follow-ups are on', () => {
    const adapter: ChatAdapter = {
      sendMessage: async () => undefined,
      sendRunInput: async () => undefined,
      resolveToolApproval: async () => undefined,
    };
    const { container } = render(Chat, {
      id: 'chat-status-waiting',
      conversation: approvalConversation('waiting'),
      adapter,
    });

    expect(statusLine(container)).toBe('Waiting for your approval · a message now steers the run');
  });

  test("the host's status wins over the derived one", () => {
    const { container } = render(Chat, {
      id: 'chat-status-host',
      conversation: approvalConversation('host'),
      composerStatus: { kind: 'reconnecting', attempt: 2 },
    });

    expect(statusLine(container)).toBe('Reconnecting… attempt 2');
  });

  test('the approval row approves through the adapter and the wait clears', async () => {
    const resolutions: unknown[] = [];
    const adapter: ChatAdapter = {
      sendMessage: async () => undefined,
      resolveToolApproval: async (toolCallId, resolution) => {
        resolutions.push([toolCallId, resolution]);
      },
    };
    const { container } = render(Chat, {
      id: 'chat-approve',
      conversation: approvalConversation('approve'),
      adapter,
    });
    const row = getByRole(container, 'article', { name: 'Run issue-refund for $42.10?' });
    expect(row.getAttribute('data-cinder-layout')).toBe('row');

    await fireEvent.click(getByRole(row, 'button', { name: 'Approve' }));
    await tick();

    expect(resolutions).toEqual([['call', { decision: 'approve', remember: false }]]);
    expect(statusLine(container)).toBeUndefined();
  });

  test('denying reads Denied on the call, not failed', async () => {
    const adapter: ChatAdapter = {
      sendMessage: async () => undefined,
      resolveToolApproval: async () => undefined,
    };
    const { container } = render(Chat, {
      id: 'chat-deny',
      conversation: approvalConversation('deny'),
      adapter,
    });
    const row = getByRole(container, 'article', { name: 'Run issue-refund for $42.10?' });

    await fireEvent.click(getByRole(row, 'button', { name: 'Deny' }));
    await tick();

    const timeline = container.querySelector('.chat-tool-call-timeline');
    expect(timeline?.querySelector('.chat-tool-call-status')?.textContent).toBe('Denied');
    expect(timeline?.querySelector('.chat-tool-call-toggle')?.textContent).toContain('1 denied');
    expect(timeline?.textContent).not.toContain('failed');
  });
});
