/**
 * COR-2286 (X4): the words a host gives an approval (its question, its consequence and its
 * footnote) take their direction from their own text, so Arabic reads right to left from its start
 * edge with its numbers and punctuation in order, while the card's own chrome keeps the page's
 * direction.
 */

/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';
import type { ApprovalCardProps } from './approval-card.types.ts';

setupHappyDom();

const { cleanup, render } = await import('@testing-library/svelte');
const { default: ApprovalCard } = await import('./approval-card.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const question = 'هل تريد استرداد الطلب 4471 بقيمة 42.00 دولارًا؟';
const consequence = 'يعيد 42.00 دولارًا إلى البطاقة الأصلية.';
const footnote = 'بعد قرارك، يتابع المشغل عند توفر مزود.';

function arabicApproval(layout: 'card' | 'row' | 'detail'): ApprovalCardProps {
  return {
    layout,
    tool: { name: 'issue-refund', label: 'Issue refund', risk: 'high' },
    operation: { kind: 'other', argsPreview: { orderId: 4471, amount: '$42.00' } },
    snapshotId: 'snapshot-123',
    policyVersion: 'policy-2026-06',
    idempotencyKey: 'approval-direction-test-key',
    state: 'pending',
    question,
    consequence,
    footnote,
    onResolve: () => undefined,
  };
}

/** The element whose own text is exactly `text`, ignoring surrounding whitespace. */
function elementWithText(container: HTMLElement, text: string): Element | undefined {
  return Array.from(container.querySelectorAll('*')).find(
    (element) =>
      element.textContent?.trim() === text &&
      Array.from(element.children).every((child) => child.textContent?.trim() !== text),
  );
}

describe('ApprovalCard text direction', () => {
  test.each([['card'], ['row'], ['detail']] as const)(
    'the %s layout reads the question, consequence and footnote in their own direction',
    (layout) => {
      const { container } = render(ApprovalCard, { props: arabicApproval(layout) });

      for (const text of [question, consequence, footnote]) {
        const element = elementWithText(container, text);
        expect(element, `no element holds "${text}"`).toBeDefined();
        expect(element?.closest('[dir="auto"]')).not.toBeNull();
      }
      // The card itself keeps the page's direction.
      expect(container.querySelector('article')?.hasAttribute('dir')).toBe(false);
    },
  );
});
