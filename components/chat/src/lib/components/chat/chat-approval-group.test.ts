/**
 * COR-2438 (COR-2282 A3): two or more approvals waiting together are one Cinder `ApprovalGroup`,
 * "2 approvals waiting", over compact rows; each approval came in a message row of its own.
 *
 * Asserts:
 *   1. Two waiting approvals of one run draw one `ApprovalGroup` named by its heading, holding both
 *      approvals as compact `row` cards and nothing else.
 *   2. The heading reads `labels.approvalsWaiting`.
 *   3. One waiting approval draws no group: it is the explicit `decision` surface on its own.
 */

/// <reference lib="dom" />
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { tick } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';
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
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
HTMLElement.prototype.scrollIntoView = () => undefined;
afterAll(() => {
  globalThis.ResizeObserver = originalResizeObserver;
  globalThis.IntersectionObserver = originalIntersectionObserver;
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
});

const { render, cleanup, getByRole } = await import('@testing-library/svelte');
const { default: Chat } = await import('./chat.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

/** One run that asked for `count` approvals, each its own call and its own message rows. */
function waiting(id: string, count: number): ConversationHistory {
  let conversation = appendUserMessage(createConversationHistory({ id }), 'Tidy the orders');
  for (let index = 1; index <= count; index += 1) {
    const callId = `call-${index}`;
    conversation = appendToolCall(conversation, {
      id: callId,
      name: 'issue-refund',
      arguments: { orderId: `44${index}` },
    });
    conversation = appendToolResult(conversation, {
      callId,
      outcome: 'action_required',
      content: null,
      action: {
        type: 'approval',
        message: `Refund order 44${index}?`,
        risk: 'high',
        operation: { kind: 'other' },
        policyVersion: 'test-policy',
        idempotencyKey: `approval-${index}`,
      },
    });
  }
  return conversation;
}

describe('Chat — approvals waiting together', () => {
  test('two waiting approvals are one ApprovalGroup of compact rows under "2 approvals waiting"', async () => {
    const { container } = render(Chat, {
      id: 'approval-group',
      conversation: waiting('approval-group', 2),
      adapter: { sendMessage: async () => undefined, resolveToolApproval: async () => undefined },
    });
    await tick();

    const groups = container.querySelectorAll('.cinder-approval-group');
    expect(groups).toHaveLength(1);
    const group = getByRole(container, 'region', { name: '2 approvals waiting' });
    expect(group).toBe(groups[0] as HTMLElement);
    const cards = Array.from(group.querySelectorAll<HTMLElement>('.cinder-approval-card'));
    expect(cards.map((card) => card.getAttribute('data-cinder-layout'))).toEqual(['row', 'row']);
    // Each approval arrived as its own message row; the group holds both rows.
    expect(group.querySelectorAll('.chat-message-wrapper')).toHaveLength(2);
    expect(container.querySelectorAll('.cinder-approval-card')).toHaveLength(2);
  });

  test('the heading reads labels.approvalsWaiting', async () => {
    const { container } = render(Chat, {
      id: 'approval-group-words',
      conversation: waiting('approval-group-words', 3),
      adapter: { sendMessage: async () => undefined, resolveToolApproval: async () => undefined },
      labels: { approvalsWaiting: (count: number) => `${count} Freigaben warten` },
    });
    await tick();

    expect(getByRole(container, 'region', { name: '3 Freigaben warten' })).not.toBeNull();
  });

  test('one waiting approval draws no group: it is the decision surface on its own', async () => {
    const { container } = render(Chat, {
      id: 'approval-single',
      conversation: waiting('approval-single', 1),
      adapter: { sendMessage: async () => undefined, resolveToolApproval: async () => undefined },
    });
    await tick();

    expect(container.querySelector('.cinder-approval-group')).toBeNull();
    expect(
      container.querySelector('.cinder-approval-card')?.getAttribute('data-cinder-layout'),
    ).toBe('decision');
  });
});
