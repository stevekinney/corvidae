/**
 * COR-2438 (COR-2282 A5, COR-2292 A5): Chat reads the `approvalDecision` metadata Bureau writes on
 * an approval's outcome row and keeps the decision as a receipt: who decided, when, and, for a
 * decision made in Reviews, where, as a link the host gives.
 *
 * Asserts:
 *   1. A decision made in Reviews by someone else reads "Approved by Priya Raman in Reviews", with
 *      "Reviews" a link to the host's address for it.
 *   2. The reader's own decision reads "by you", in the host's word for "you".
 *   3. A decision made in a chat names no place, and metadata that does not read whole draws no
 *      receipt: the call's result reads as it always did.
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
import { readRecordedApprovalDecision } from './utilities/recorded-approval-decision.ts';

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

const { render, cleanup } = await import('@testing-library/svelte');
const { default: Chat } = await import('./chat.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

/** A refund the run asked about and someone decided, with the decision as Bureau recorded it. */
function decided(id: string, record: Record<string, string>): ConversationHistory {
  const conversation = appendToolCall(
    appendUserMessage(createConversationHistory({ id }), 'refund it'),
    { id: 'call-refund', name: 'issue-refund', arguments: { orderId: '4471' } },
  );
  return appendToolResult(
    conversation,
    { callId: 'call-refund', outcome: 'success', content: 'Refunded $42.00.' },
    { metadata: { approvalDecision: record } },
  );
}

function receiptText(container: HTMLElement): string {
  return (
    container.querySelector('.cinder-approval-card')?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
  );
}

describe('Chat — a decision recorded on the outcome row', () => {
  test('a decision made in Reviews names who decided and links the place', async () => {
    const { container } = render(Chat, {
      id: 'receipt-reviews',
      conversation: decided('receipt-reviews', {
        decision: 'approve',
        decidedBy: 'Priya Raman',
        decidedAt: '2026-11-17T10:46:00.000Z',
        asked: 'Refund order 4471 for $42.00',
        decisionSurface: 'reviews',
      }),
      approvalReceiptHref: (toolCallId: string) => `/reviews/approval:${toolCallId}`,
    });
    await tick();

    expect(receiptText(container)).toContain('Approved by Priya Raman in Reviews');
    const link = container.querySelector<HTMLAnchorElement>('.cinder-approval-card a[href]');
    expect(link?.getAttribute('href')).toBe('/reviews/approval:call-refund');
    expect(link?.textContent?.trim()).toBe('Reviews');
  });

  test('the reader’s own decision reads as the host’s word for you', async () => {
    const { container } = render(Chat, {
      id: 'receipt-own',
      conversation: decided('receipt-own', {
        decision: 'deny',
        decidedBy: 'principal:owner',
        decidedAt: '2026-11-17T10:40:00.000Z',
        decisionSurface: 'reviews',
      }),
      currentPrincipal: 'principal:owner',
      labels: { you: 'dich' },
    });
    await tick();

    expect(receiptText(container)).toContain('Denied by dich in Reviews');
    // Without an address from the host the place is plain text.
    expect(container.querySelector('.cinder-approval-card a[href]')).toBeNull();
  });

  test('a decision made in a chat names no place', async () => {
    const { container } = render(Chat, {
      id: 'receipt-chat',
      conversation: decided('receipt-chat', {
        decision: 'approve',
        decidedBy: 'Priya Raman',
        decidedAt: '2026-11-17T10:46:00.000Z',
        decisionSurface: 'chat',
      }),
      approvalReceiptHref: () => '/reviews/never',
    });
    await tick();

    expect(receiptText(container)).toContain('Approved by Priya Raman');
    expect(receiptText(container)).not.toContain(' in ');
    expect(container.querySelector('.cinder-approval-card a[href]')).toBeNull();
  });

  test('metadata that does not read whole draws no receipt', async () => {
    const { container } = render(Chat, {
      id: 'receipt-broken',
      conversation: decided('receipt-broken', { decision: 'maybe', decidedBy: 'Priya Raman' }),
    });
    await tick();

    expect(container.querySelector('.cinder-approval-card')).toBeNull();
  });

  test('reads only the row’s own fields, never an inherited one', () => {
    const inherited = Object.create({
      approvalDecision: {
        decision: 'approve',
        decidedBy: 'someone',
        decidedAt: '2026-11-17T10:46:00.000Z',
      },
    }) as Record<string, unknown>;
    expect(readRecordedApprovalDecision(inherited)).toBeUndefined();
    expect(
      readRecordedApprovalDecision({
        approvalDecision: {
          decision: 'reject',
          decidedBy: 'Priya Raman',
          decidedAt: '2026-11-17T10:46:00.000Z',
          decisionSurface: 'Reviews',
        },
      }),
    ).toEqual({
      outcome: 'denied',
      decidedBy: 'Priya Raman',
      decidedAt: Date.parse('2026-11-17T10:46:00.000Z'),
    });
  });
});
