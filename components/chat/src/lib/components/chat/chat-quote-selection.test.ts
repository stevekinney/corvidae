/**
 * Selecting text in an agent message offers Quote in a Cinder `SelectionPopover`.
 *
 * Asserts:
 *   1. A selection inside one assistant message's content opens the popover
 *      with a Quote action.
 *   2. A selection spanning two messages, or one that lies outside assistant
 *      content, opens nothing.
 *   3. Quote adds the selected text as a chip, closes the popover and clears the
 *      selection.
 *   4. At the quote limit the Quote action is disabled and says why.
 *   5. Collapsing the selection closes an open popover.
 */

/// <reference lib="dom" />
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { tick } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';
import {
  appendAssistantMessage,
  appendUserMessage,
  createConversationHistory,
} from './builders.ts';
import {
  giveRangesGeometry,
  isQuotePopoverOpen,
  popoverQuoteButton,
  quoteChips,
  quotePopover,
  selectBetween,
  selectText,
} from './chat-quote-test-support.ts';

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

let restoreGeometry: () => void = () => {};
beforeAll(() => {
  restoreGeometry = giveRangesGeometry();
});
afterAll(() => {
  restoreGeometry();
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

function twoReplies(id: string) {
  return appendAssistantMessage(
    appendAssistantMessage(
      appendUserMessage(createConversationHistory({ id }), 'Tell me about fruit.'),
      'Apples are crisp and sweet.',
    ),
    'Pears are soft and juicy.',
  );
}

function assistantBodies(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>('[data-message-role="assistant"] .chat-message-body'),
  );
}

describe('Chat selection Quote popover', () => {
  test('opens with a Quote action for a selection inside one assistant message', async () => {
    const { container } = render(Chat, { id: 'chat-sel-inside', conversation: twoReplies('a') });
    expect(isQuotePopoverOpen()).toBe(false);

    selectText(assistantBodies(container)[0]!, 'crisp and sweet');
    await tick();

    expect(isQuotePopoverOpen()).toBe(true);
    expect(popoverQuoteButton()?.textContent?.trim()).toBe('Quote');
  });

  test('opens nothing for a selection that spans more than one message', async () => {
    const { container } = render(Chat, { id: 'chat-sel-across', conversation: twoReplies('b') });
    const bodies = assistantBodies(container);

    selectBetween(bodies[0]!, 'crisp', bodies[1]!, 'soft');
    await tick();

    expect(isQuotePopoverOpen()).toBe(false);
  });

  test('opens nothing for a selection inside a user message', async () => {
    const { container } = render(Chat, { id: 'chat-sel-user', conversation: twoReplies('c') });
    const userBody = container.querySelector<HTMLElement>(
      '[data-message-role="user"] .chat-message-body',
    )!;

    selectText(userBody, 'about fruit');
    await tick();

    expect(isQuotePopoverOpen()).toBe(false);
  });

  test('opens nothing for a selection that runs from assistant content out of it', async () => {
    const { container } = render(Chat, { id: 'chat-sel-spill', conversation: twoReplies('d') });
    const header = container.querySelectorAll<HTMLElement>(
      '[data-message-role="assistant"] .chat-message-header',
    )[1]!;

    selectBetween(assistantBodies(container)[0]!, 'Apples', header, 'Assistant');
    await tick();

    expect(isQuotePopoverOpen()).toBe(false);
  });

  test('opens nothing for a selection in the composer area', async () => {
    const { container } = render(Chat, { id: 'chat-sel-composer', conversation: twoReplies('e') });
    const form = container.querySelector<HTMLElement>('form.chat-input')!;

    selectText(form, 'Press Enter');
    await tick();

    expect(isQuotePopoverOpen()).toBe(false);
  });

  test('Quote adds the selected text as a chip, closes the popover and clears the selection', async () => {
    const { container } = render(Chat, { id: 'chat-sel-quote', conversation: twoReplies('f') });

    selectText(assistantBodies(container)[1]!, 'soft and juicy');
    await tick();
    await fireEvent.click(popoverQuoteButton()!);
    await tick();

    const chips = quoteChips(container);
    expect(chips).toHaveLength(1);
    expect(chips[0]!.textContent).toContain('soft and juicy');
    expect(chips[0]!.textContent).not.toContain('Pears');
    expect(isQuotePopoverOpen()).toBe(false);
    expect(window.getSelection()!.isCollapsed).toBe(true);
  });

  test('closes when the selection collapses', async () => {
    const { container } = render(Chat, { id: 'chat-sel-collapse', conversation: twoReplies('g') });

    selectText(assistantBodies(container)[0]!, 'Apples');
    await tick();
    expect(isQuotePopoverOpen()).toBe(true);

    window.getSelection()!.removeAllRanges();
    await tick();

    expect(isQuotePopoverOpen()).toBe(false);
  });

  test('disables Quote and explains why once ten quotes are collected', async () => {
    let conversation = appendUserMessage(createConversationHistory({ id: 'h' }), 'Count.');
    for (let index = 1; index <= 11; index += 1) {
      conversation = appendAssistantMessage(conversation, `Reply number ${index} of eleven.`);
    }
    const { container } = render(Chat, { id: 'chat-sel-limit', conversation });
    const bodies = assistantBodies(container);

    for (let index = 0; index < 10; index += 1) {
      selectText(bodies[index]!, `Reply number ${index + 1} `);
      await tick();
      await fireEvent.click(popoverQuoteButton()!);
      await tick();
    }
    expect(quoteChips(container)).toHaveLength(10);

    selectText(bodies[10]!, 'Reply number 11');
    await tick();

    const quote = popoverQuoteButton()!;
    expect(quote.disabled).toBe(true);
    const explanation = document.getElementById(quote.getAttribute('aria-describedby') ?? '');
    expect(explanation?.textContent).toContain('10');
    expect(quotePopover()).not.toBeNull();
  });
});
