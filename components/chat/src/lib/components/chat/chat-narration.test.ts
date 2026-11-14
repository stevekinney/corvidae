/**
 * What an agent says while it works (narration) is told apart from its answer by position in the
 * turn: Chat marks an assistant text message that a tool message follows, and draws it muted at the
 * notice size in the transcript presentation. The answer, and every message in the default
 * presentation, is drawn as before.
 */

/// <reference lib="dom" />
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { tick } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';
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

const { render, cleanup } = await import('@testing-library/svelte');
const { default: Chat } = await import('./chat.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function turn(id: string, withAnswer: boolean): ConversationHistory {
  let conversation = appendUserMessage(createConversationHistory({ id }), 'Check the ledger');
  conversation = appendAssistantMessage(conversation, 'Reading the ledger entries now');
  conversation = appendToolCall(conversation, {
    id: 'lookup-1',
    name: 'read_ledger',
    arguments: { account: 'main' },
  });
  conversation = appendToolResult(conversation, {
    callId: 'lookup-1',
    outcome: 'success',
    content: 'ok',
  });
  return withAnswer ? appendAssistantMessage(conversation, 'The ledger balances.') : conversation;
}

function narrationTexts(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.chat-message-wrapper[data-narration]')].map(
    (wrapper) => wrapper.querySelector('.chat-message-body')?.textContent?.trim() ?? '',
  );
}

describe('Chat — narration and answer', () => {
  test('the text before a tool is narration and the text after the last tool is the answer', async () => {
    const { container } = render(Chat, {
      id: 'narration-answer',
      conversation: turn('narration-answer', true),
      variant: 'transcript',
    });
    await tick();

    expect(narrationTexts(container)).toEqual(['Reading the ledger entries now']);
    const answer = [...container.querySelectorAll('.chat-message-wrapper[data-role="assistant"]')]
      .filter((wrapper) => !wrapper.hasAttribute('data-narration'))
      .map((wrapper) => wrapper.querySelector('.chat-message-body')?.textContent?.trim());
    expect(answer).toEqual(['The ledger balances.']);
  });

  test('a turn that stops after its tool keeps its narration marked', async () => {
    const { container } = render(Chat, {
      id: 'narration-only',
      conversation: turn('narration-only', false),
      variant: 'transcript',
    });
    await tick();

    expect(narrationTexts(container)).toEqual(['Reading the ledger entries now']);
  });

  test('the default presentation marks nothing', async () => {
    const { container } = render(Chat, {
      id: 'narration-default',
      conversation: turn('narration-default', true),
    });
    await tick();

    expect(container.querySelectorAll('[data-narration]')).toHaveLength(0);
  });
});
