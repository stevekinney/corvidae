/**
 * COR-2438 (COR-2280 A7): an approval whose deadline passed before anyone decided it is drawn as
 * "Expired before a decision", with no Deny or Approve, when it lapsed under it, and a secondary
 * Ask again that asks the host for a fresh approval of the same call.
 */

/// <reference lib="dom" />
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tick } from 'svelte';

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

const { render, fireEvent, cleanup, getByRole, queryByRole } =
  await import('@testing-library/svelte');
const { default: Chat } = await import('./chat.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function lapsed(id: string) {
  return appendToolResult(
    appendToolCall(appendUserMessage(createConversationHistory({ id }), 'refund it'), {
      id: 'call-refund',
      name: 'issue-refund',
      arguments: { orderId: '4471' },
    }),
    {
      callId: 'call-refund',
      outcome: 'action_required',
      content: null,
      action: {
        type: 'approval',
        message: 'Refund order 4471 for $42.00?',
        risk: 'high',
        operation: { kind: 'other' },
        expiresAt: '2020-01-01T10:15:00.000Z',
        policyVersion: 'test-policy',
        idempotencyKey: 'lapsed',
      },
    },
  );
}

describe('Chat — an approval that expired before a decision', () => {
  test('reads Expired before a decision, offers no decision, and Ask again asks for it again', async () => {
    const asked: string[] = [];
    const { container } = render(Chat, {
      id: 'approval-lapsed',
      conversation: lapsed('approval-lapsed'),
      adapter: { sendMessage: async () => undefined, resolveToolApproval: async () => undefined },
      onApprovalRequestAgain: (toolCallId: string) => asked.push(toolCallId),
    });
    await tick();

    const card = container.querySelector<HTMLElement>('.cinder-approval-card')!;
    expect(card.getAttribute('data-cinder-state')).toBe('expired');
    expect(card.textContent).toContain('Expired before a decision');
    expect(queryByRole(card, 'button', { name: 'Deny' })).toBeNull();
    expect(queryByRole(card, 'button', { name: /^Approve/ })).toBeNull();
    expect(container.querySelector('.chat-approval-time time')?.getAttribute('datetime')).toBe(
      '2020-01-01T10:15:00.000Z',
    );

    await fireEvent.click(getByRole(card, 'button', { name: 'Ask again' }));
    expect(asked).toEqual(['call-refund']);
  });

  test('draws it as Cinder’s quiet dashed neutral row, not a warning-toned card (owner decision)', () => {
    const css = readFileSync(
      join(import.meta.dir, '../../../../../cinder/src/components/approval-card/approval-card.css'),
      'utf8',
    );
    const rule = css.match(
      /\.cinder-approval-card--decision\[data-cinder-state='expired'\][^{]*\{([^}]*)\}/,
    )?.[1];
    expect(rule).toMatch(/border-style:\s*dashed;/);
    expect(rule).not.toMatch(/status-warning/);
  });
});
