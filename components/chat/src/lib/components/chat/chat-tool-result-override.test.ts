/**
 * The README recipe "Showing a typed tool result": a consumer's `messagePart` override presents
 * one tool's successful result as a Cinder Badge and delegates everything else to Chat's built-in
 * rendering. The paired cases run through a whole `Chat`, so the override sees the pairing the
 * container resolves, not a hand-built part.
 */

/// <reference lib="dom" />
import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';
import type { ConversationHistory, Message, ToolResult } from './conversation-model.ts';

setupHappyDom();

class TestResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
class TestIntersectionObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}
const originalResizeObserver = globalThis.ResizeObserver;
const originalIntersectionObserver = globalThis.IntersectionObserver;
globalThis.ResizeObserver = TestResizeObserver;
globalThis.IntersectionObserver =
  TestIntersectionObserver as unknown as typeof IntersectionObserver;
afterAll(() => {
  globalThis.ResizeObserver = originalResizeObserver;
  globalThis.IntersectionObserver = originalIntersectionObserver;
});

const { render, cleanup } = await import('@testing-library/svelte');
const { default: ToolResultOverrideFixture } =
  await import('./chat-tool-result-override-fixture.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const NOW = '2026-06-02T00:00:00.000Z';
let counter = 0;

function conversationOf(...messages: Array<Partial<Message> & Pick<Message, 'role'>>) {
  const built: Record<string, Message> = {};
  const ids: string[] = [];
  for (const [position, partial] of messages.entries()) {
    const id = `tool-result-override-${++counter}`;
    ids.push(id);
    built[id] = {
      id,
      content: '',
      position,
      createdAt: NOW,
      metadata: {},
      hidden: false,
      ...partial,
    };
  }
  const conversation: ConversationHistory = {
    schemaVersion: 4,
    id: `tool-result-override-conversation-${++counter}`,
    status: 'active',
    metadata: {},
    ids,
    messages: built,
    createdAt: NOW,
    updatedAt: NOW,
  };
  return conversation;
}

function call(name: string, id = 'call-inventory'): Partial<Message> & Pick<Message, 'role'> {
  return { role: 'tool-call', toolCall: { id, name, arguments: { sku: 'notebook' } } };
}

function result(
  toolResult: Omit<ToolResult, 'callId'>,
  callId = 'call-inventory',
): Partial<Message> & Pick<Message, 'role'> {
  return { role: 'tool-result', toolResult: { callId, ...toolResult } };
}

function renderChat(conversation: ConversationHistory): HTMLElement {
  return render(ToolResultOverrideFixture, { props: { conversation } }).container;
}

function badges(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.cinder-badge'));
}

/** Chat's own tool-call card, which the override replaces only for a valid inventory result. */
function defaultCards(container: HTMLElement): number {
  return container.querySelectorAll('.chat-tool-call-list').length;
}

describe('typed tool result recipe', () => {
  test('a valid lookup_inventory result replaces the default card with a named Badge', () => {
    const container = renderChat(
      conversationOf(
        call('lookup_inventory'),
        result({ outcome: 'success', content: { item: 'Notebook', available: 3 } }),
      ),
    );

    const found = badges(container);
    expect(found).toHaveLength(1);
    expect(found[0]!.textContent?.trim()).toBe('Notebook: 3 available');
    expect(defaultCards(container)).toBe(0);
  });

  test('accepts zero available and ignores extra fields', () => {
    const container = renderChat(
      conversationOf(
        call('lookup_inventory'),
        result({ outcome: 'success', content: { item: 'Pen', available: 0, aisle: 4 } }),
      ),
    );
    expect(badges(container).map((badge) => badge.textContent?.trim())).toEqual([
      'Pen: 0 available',
    ]);
  });

  test('a result that arrives later replaces the pending default card', async () => {
    const pending = conversationOf(call('lookup_inventory'));
    const { container, rerender } = render(ToolResultOverrideFixture, {
      props: { conversation: pending },
    });
    expect(badges(container)).toHaveLength(0);
    expect(defaultCards(container)).toBe(1);

    await rerender({
      conversation: conversationOf(
        call('lookup_inventory'),
        result({ outcome: 'success', content: { item: 'Notebook', available: 3 } }),
      ),
    });
    expect(badges(container).map((badge) => badge.textContent?.trim())).toEqual([
      'Notebook: 3 available',
    ]);
    expect(defaultCards(container)).toBe(0);
  });

  const delegated: Array<[string, Array<Partial<Message> & Pick<Message, 'role'>>]> = [
    [
      'a string count',
      [
        call('lookup_inventory'),
        result({ outcome: 'success', content: { item: 'Notebook', available: '3' } }),
      ],
    ],
    [
      'a negative count',
      [
        call('lookup_inventory'),
        result({ outcome: 'success', content: { item: 'Notebook', available: -1 } }),
      ],
    ],
    [
      'a fractional count',
      [
        call('lookup_inventory'),
        result({ outcome: 'success', content: { item: 'Notebook', available: 1.5 } }),
      ],
    ],
    [
      'an empty item',
      [
        call('lookup_inventory'),
        result({ outcome: 'success', content: { item: '', available: 3 } }),
      ],
    ],
    [
      'a missing field',
      [call('lookup_inventory'), result({ outcome: 'success', content: { item: 'Notebook' } })],
    ],
    [
      'array content',
      [call('lookup_inventory'), result({ outcome: 'success', content: ['Notebook', 3] })],
    ],
    ['null content', [call('lookup_inventory'), result({ outcome: 'success', content: null })]],
    ['a pending result', [call('lookup_inventory')]],
    [
      'a failed result',
      [
        call('lookup_inventory'),
        result({
          outcome: 'error',
          content: { item: 'Notebook', available: 3 },
          error: { code: 'failed', category: 'internal', retryable: false, message: 'Failed' },
        }),
      ],
    ],
    [
      'a multipart result',
      [
        call('lookup_inventory'),
        result({
          outcome: 'success',
          content: { item: 'Notebook', available: 3 },
          parts: [{ type: 'text', text: 'Notebook: 3 available' }],
        }),
      ],
    ],
    [
      'an unrelated tool',
      [
        call('lookup_price'),
        result({ outcome: 'success', content: { item: 'Notebook', available: 3 } }),
      ],
    ],
  ];

  test.each(delegated)('%s delegates to the default card', (_name, messages) => {
    const container = renderChat(conversationOf(...messages));
    expect(badges(container)).toHaveLength(0);
    expect(defaultCards(container)).toBe(1);
  });

  test('a standalone result with no paired call delegates to the default', () => {
    const container = renderChat(
      conversationOf(
        result(
          { outcome: 'success', content: { item: 'Notebook', available: 3 } },
          'call-without-a-call',
        ),
      ),
    );
    expect(badges(container)).toHaveLength(0);
    expect(container.textContent).toContain('Notebook');
  });

  test('built-in approval and input flows stay reachable for the same tool', () => {
    const approval = renderChat(
      conversationOf(
        call('lookup_inventory'),
        result({
          outcome: 'action_required',
          content: null,
          action: {
            type: 'approval',
            message: 'Let the assistant read inventory?',
            risk: 'low',
            operation: { kind: 'command', command: 'lookup_inventory', argsPreview: {} },
            policyVersion: 'recipe-policy',
            idempotencyKey: 'recipe-approval',
          },
        }),
      ),
    );
    expect(badges(approval)).toHaveLength(0);
    expect(approval.textContent).toContain('Let the assistant read inventory?');
    expect(approval.querySelector('.cinder-approval-card')).not.toBeNull();
    cleanup();

    const input = renderChat(
      conversationOf(
        call('lookup_inventory'),
        result({
          outcome: 'action_required',
          content: null,
          action: {
            type: 'input',
            message: 'Which warehouse?',
            schema: {
              type: 'object',
              properties: { warehouse: { type: 'string', title: 'Warehouse' } },
              required: ['warehouse'],
            },
          },
        }),
      ),
    );
    expect(badges(input)).toHaveLength(0);
    expect(input.textContent).toContain('Which warehouse?');
    expect(input.querySelector('form, input, textarea')).not.toBeNull();
  });
});
