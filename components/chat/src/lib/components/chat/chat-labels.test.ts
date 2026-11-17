/**
 * COR-2438 (COR-2282, COR-2262): Chat takes one `labels` object that every word it draws reads.
 *
 * Asserts:
 *   1. A step group's count ("N steps") reads `labels.steps`, with no second labels prop.
 *   2. The sources read `labels`, and Chat forwards its source words to Citation's own labels: the
 *      count, the no-link note and the unsafe-link note.
 *   3. The defaults hold every word of a turn, a step group and the docked question, so a host
 *      that passes nothing reads English.
 */

/// <reference lib="dom" />
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { tick } from 'svelte';

import type { CitationSource } from '@lostgradient/cinder';
import { setupHappyDom } from '@lostgradient/testing';
import {
  appendAssistantMessage,
  appendToolCall,
  appendToolResult,
  appendUserMessage,
  createConversationHistory,
} from './builders.ts';
import { DEFAULT_CHAT_LABELS, resolveChatLabels } from './chat-labels.ts';
import { DEFAULT_TURN_LABELS } from './message/turn-labels.ts';
import { DEFAULT_QUESTION_DOCK_LABELS } from './question/question-dock-labels.ts';

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

function twoSteps(id: string) {
  let conversation = appendUserMessage(createConversationHistory({ id }), 'Check both');
  for (const callId of ['step-1', 'step-2']) {
    conversation = appendToolCall(conversation, {
      id: callId,
      name: 'fetch_source',
      arguments: { url: `https://example.com/${callId}` },
    });
    conversation = appendToolResult(conversation, { callId, outcome: 'success', content: 'ok' });
  }
  return appendAssistantMessage(conversation, 'Both sources agree.');
}

describe('Chat — one labels object', () => {
  test('a step group counts its steps in the words of labels.steps', async () => {
    const { container } = render(Chat, {
      id: 'labels-steps',
      conversation: twoSteps('labels-steps'),
      labels: { steps: (count: number) => `${count} étapes` },
    });
    await tick();

    expect(container.querySelector('.chat-tool-call-summary-count')?.textContent).toBe('2 étapes');
  });

  test('the sources read labels, and Chat forwards its source words to Citation', async () => {
    let conversation = appendUserMessage(createConversationHistory({ id: 'labels-sources' }), 'Q');
    conversation = appendAssistantMessage(conversation, 'Answer.');
    const assistantId = conversation.ids.at(-1)!;
    const sources: readonly CitationSource[] = [
      { label: 'Board minutes' },
      { label: 'Unsafe source', url: 'javascript:alert(1)' },
    ];
    const { container } = render(Chat, {
      id: 'labels-sources',
      conversation,
      sourcesByMessageId: new Map([[assistantId, sources]]),
      labels: {
        sources: 'Fuentes',
        sourcesCount: (count: number) => `${count} fuentes`,
        internalDocument: 'Documento interno, sin enlace público',
        unsafeLink: 'Enlace oculto: la dirección no es segura',
      },
    });
    await tick();

    const marker = container.querySelector<HTMLButtonElement>(
      '[data-chat-sources-trigger] .cinder-citation__marker',
    );
    expect(marker?.textContent?.trim()).toBe('2 fuentes');
    await fireEvent.click(marker!);
    await tick();

    const notes = Array.from(container.querySelectorAll('.cinder-citation__note')).map((note) =>
      note.textContent?.trim(),
    );
    expect(notes).toEqual([
      'Documento interno, sin enlace público',
      'Enlace oculto: la dirección no es segura',
    ]);
  });

  test('the defaults hold every word of a turn, a step group and the docked question', () => {
    for (const [key, value] of Object.entries(DEFAULT_TURN_LABELS)) {
      expect(DEFAULT_CHAT_LABELS[key as keyof typeof DEFAULT_CHAT_LABELS]).toBe(value);
    }
    for (const [key, value] of Object.entries(DEFAULT_QUESTION_DOCK_LABELS)) {
      expect(DEFAULT_CHAT_LABELS[key as keyof typeof DEFAULT_CHAT_LABELS]).toBe(value);
    }
    expect(resolveChatLabels({ steps: () => 'x' }).stepsDone(1, 2)).toBe('1 of 2 steps');
    expect(DEFAULT_CHAT_LABELS.approvalsWaiting(2)).toBe('2 approvals waiting');
  });
});
