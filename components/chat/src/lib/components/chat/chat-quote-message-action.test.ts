/**
 * Quote message action: the keyboard path for quoting part of an agent message.
 *
 * Asserts:
 *   1. Every assistant message has a "Quote message" action.
 *   2. With no selection, activating it quotes the message's rendered text and
 *      shows it as a removable chip above the composer.
 *   3. With a selection inside that message, it quotes the selection instead.
 *   4. User messages do not offer it.
 */

/// <reference lib="dom" />
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { tick } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';
import {
  appendAssistantMessage,
  appendUserMessage,
  createConversationHistory,
} from './builders.ts';
import { quoteChips, quoteMessageButtons, selectText } from './chat-quote-test-support.ts';

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
  window.getSelection()?.removeAllRanges();
  cleanup();
  document.body.replaceChildren();
});

describe('Chat Quote message action', () => {
  test('quotes the whole rendered message when nothing is selected', async () => {
    const conversation = appendAssistantMessage(
      appendUserMessage(createConversationHistory({ id: 'quote-whole' }), 'hello'),
      'The answer is forty-two.',
    );
    const { container } = render(Chat, { id: 'chat-quote-whole', conversation });

    const buttons = quoteMessageButtons(container);
    expect(buttons).toHaveLength(1);
    expect(quoteChips(container)).toHaveLength(0);

    await fireEvent.click(buttons[0]!);
    await tick();

    const chips = quoteChips(container);
    expect(chips).toHaveLength(1);
    expect(chips[0]!.textContent).toContain('The answer is forty-two.');
    expect(chips[0]!.querySelector('button[data-quote-remove]')).not.toBeNull();
  });

  test('quotes the selection when one lies inside the message', async () => {
    const conversation = appendAssistantMessage(
      appendUserMessage(createConversationHistory({ id: 'quote-selection' }), 'hello'),
      'The answer is forty-two.',
    );
    const { container } = render(Chat, { id: 'chat-quote-selection', conversation });

    selectText(
      container.querySelector<HTMLElement>('[data-message-role="assistant"] .chat-message-body')!,
      'forty-two',
    );

    await fireEvent.click(quoteMessageButtons(container)[0]!);
    await tick();

    const chips = quoteChips(container);
    expect(chips).toHaveLength(1);
    expect(chips[0]!.textContent).toContain('forty-two');
    expect(chips[0]!.textContent).not.toContain('The answer');
  });

  test('quotes the whole message when the selection lies in a different message', async () => {
    const conversation = appendAssistantMessage(
      appendAssistantMessage(
        appendUserMessage(createConversationHistory({ id: 'quote-other' }), 'hello'),
        'First reply about apples.',
      ),
      'Second reply about pears.',
    );
    const { container } = render(Chat, { id: 'chat-quote-other', conversation });

    const bodies = container.querySelectorAll<HTMLElement>(
      '[data-message-role="assistant"] .chat-message-body',
    );
    selectText(bodies[0]!, 'apples');

    await fireEvent.click(quoteMessageButtons(container)[1]!);
    await tick();

    const chips = quoteChips(container);
    expect(chips).toHaveLength(1);
    expect(chips[0]!.textContent).toContain('Second reply about pears.');
  });

  test('does not offer Quote message on user messages', () => {
    const conversation = appendUserMessage(
      createConversationHistory({ id: 'quote-user' }),
      'only a user message',
    );
    const { container } = render(Chat, { id: 'chat-quote-user', conversation });

    expect(quoteMessageButtons(container)).toHaveLength(0);
  });
});
