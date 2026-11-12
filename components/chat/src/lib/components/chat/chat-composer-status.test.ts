/**
 * The line under the composer and the one-row approval, as Chat wires them: a pending approval
 * leaves the composer's hint alone, the host's own status (a note, a reconnect, queued follow-ups,
 * a blocked composer) replaces it, and the row's Approve and Deny reach the adapter.
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
  // A reconnect is a notice above the composer (Cinder's Callout); the rest are the line under it.
  const element =
    container.querySelector('.chat-input-status') ??
    container.querySelector('[data-chat-composer-drawer="reconnecting"]');
  // The spinner's own (hidden) label repeats the sentence, so read the sentence's own text.
  const sentence = element?.querySelector('.cinder-callout__content') ?? element;
  return sentence?.textContent?.trim() ?? undefined;
}

describe('Chat composer status and approval row', () => {
  test('shows the hint, and no status line, when nothing is waiting', () => {
    const { container } = render(Chat, {
      id: 'chat-status-idle',
      conversation: appendUserMessage(createConversationHistory({ id: 'idle' }), 'hi'),
    });

    expect(statusLine(container)).toBeUndefined();
    expect(container.querySelector('.chat-input-hint')?.textContent).toBe(
      'Enter to send. Shift and Enter for a new line.',
    );
  });

  test('a pending approval keeps the hint and the composer live, with a quiet disabled Send', () => {
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

    expect(statusLine(container)).toBeUndefined();
    expect(container.querySelector('.chat-input-hint')).not.toBeNull();
    const send = container.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')!;
    expect(send.getAttribute('data-cinder-variant')).toBe('secondary');
    expect(send.disabled).toBe(true);
  });

  test("the host's status replaces the hint", () => {
    const { container } = render(Chat, {
      id: 'chat-status-host',
      conversation: approvalConversation('host'),
      composerStatus: { kind: 'reconnecting', attempt: 3 },
    });

    expect(statusLine(container)).toBe('Reconnecting… attempt 3');
    expect(container.querySelector('.chat-input-hint')).toBeNull();
  });

  test('a reconnecting stream keeps Stop, though nothing is streaming into the transcript', () => {
    const { container } = render(Chat, {
      id: 'chat-status-reconnecting-stop',
      conversation: appendUserMessage(createConversationHistory({ id: 'rs' }), 'hi'),
      adapter: { sendMessage: async () => undefined, sendRunInput: async () => undefined },
      composerStatus: { kind: 'reconnecting', attempt: 3 },
    });

    expect(container.querySelector('button[aria-label="Stop generating"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Send message"]')).toBeNull();
    expect(statusLine(container)).toBe('Reconnecting… attempt 3');
  });

  test('Stop while reconnecting reaches the host before any reply has a row', async () => {
    const stopped: string[] = [];
    const conversation = appendUserMessage(createConversationHistory({ id: 'rs-stop' }), 'hi');
    const { container } = render(Chat, {
      id: 'chat-status-reconnecting-stop-sends',
      conversation,
      adapter: {
        sendMessage: async () => undefined,
        sendRunInput: async () => undefined,
        stopGenerating: async (messageId) => {
          stopped.push(messageId);
        },
      },
      composerStatus: { kind: 'reconnecting', attempt: 1 },
    });

    await fireEvent.click(container.querySelector('button[aria-label="Stop generating"]')!);

    expect(stopped).toEqual([conversation.ids.at(-1)!]);
  });

  test.each([
    [{ kind: 'steering' }, 'A message now steers the run.'],
    [
      { kind: 'note', text: 'Effort High applies from the next step.' },
      'Effort High applies from the next step.',
    ],
    [{ kind: 'queued' }, 'Follow-up queued until the run is ready'],
  ] as const)('shows %j under the composer', (composerStatus, text) => {
    const { container } = render(Chat, {
      id: `chat-status-${composerStatus.kind}`,
      conversation: createConversationHistory({ id: composerStatus.kind }),
      composerStatus,
    });

    expect(statusLine(container)).toBe(text);
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
    expect(row.getAttribute('data-cinder-layout')).toBe('decision');

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
