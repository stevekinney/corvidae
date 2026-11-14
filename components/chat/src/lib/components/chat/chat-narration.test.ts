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
  test('while the agent works, the text before a tool is narration drawn in place and the text after is the answer', async () => {
    const { container } = render(Chat, {
      id: 'narration-answer',
      conversation: turn('narration-answer', true),
      variant: 'transcript',
      streaming: true,
    });
    await tick();

    expect(narrationTexts(container)).toEqual(['Reading the ledger entries now']);
    const answer = [...container.querySelectorAll('.chat-message-wrapper[data-role="assistant"]')]
      .filter((wrapper) => !wrapper.hasAttribute('data-narration'))
      .map((wrapper) => wrapper.querySelector('.chat-message-body')?.textContent?.trim());
    expect(answer).toEqual(['The ledger balances.']);
    expect(container.querySelectorAll('.chat-tool-call-narration')).toHaveLength(0);
  });

  test('once the answer settles, the narration folds into the step group and the answer stays mounted', async () => {
    const conversation = turn('narration-fold', true);
    const { container, rerender } = render(Chat, {
      id: 'narration-fold',
      conversation,
      variant: 'transcript',
      streaming: true,
    });
    await tick();
    const answerWrapper = [
      ...container.querySelectorAll<HTMLElement>('.chat-message-wrapper[data-role="assistant"]'),
    ].find((wrapper) => wrapper.textContent?.includes('The ledger balances.'));
    expect(answerWrapper).toBeDefined();

    await rerender({ streaming: false });
    await tick();

    // The narration is no longer a message of its own: it lives in the group, which counts steps.
    expect(narrationTexts(container)).toEqual([]);
    expect(container.querySelectorAll('.chat-tool-call-timeline')).toHaveLength(1);
    expect(container.querySelector('.chat-tool-call-summary-count')?.textContent).toBe('1 step');
    const folded = [...container.querySelectorAll('.chat-tool-call-narration')];
    expect(folded.map((line) => line.textContent?.trim())).toEqual([
      'Reading the ledger entries now',
    ]);
    // The group is closed, so the line is not shown, and it is inside the group's list.
    expect(container.querySelector<HTMLElement>('.chat-tool-call-list')?.hidden).toBe(true);
    expect(folded[0]?.closest('.chat-tool-call-list')).not.toBeNull();
    // The answer's message component did not remount: the same element, and the only prose outside.
    const settledAnswer = [
      ...container.querySelectorAll<HTMLElement>('.chat-message-wrapper[data-role="assistant"]'),
    ];
    expect(settledAnswer).toHaveLength(1);
    expect(settledAnswer[0]).toBe(answerWrapper);
  });

  test('opening the group shows the narration between the steps, and the closed row counts steps only', async () => {
    const { container } = render(Chat, {
      id: 'narration-open',
      conversation: turn('narration-open', true),
      variant: 'transcript',
    });
    await tick();

    container.querySelector<HTMLButtonElement>('.chat-tool-call-toggle')!.click();
    await tick();

    const list = container.querySelector<HTMLElement>('.chat-tool-call-list')!;
    expect(list.hidden).toBe(false);
    expect([...list.children].map((item) => item.className.split(' ')[0])).toEqual([
      'chat-tool-call-narration',
      'chat-tool-call-item',
    ]);
    expect(
      container
        .querySelector('.chat-tool-call-timeline')
        ?.getAttribute('data-cinder-tool-call-count'),
    ).toBe('1');
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
