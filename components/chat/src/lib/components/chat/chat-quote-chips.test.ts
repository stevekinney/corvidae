/**
 * The chip row above the composer.
 *
 * Asserts:
 *   1. A chip shows the first 80 characters of its quote and has a Remove button.
 *   2. Removing a chip removes only that quote and keeps focus in the composer
 *      area.
 *   3. Chips keep the order the quotes were added in.
 *   4. Quoting identical text twice adds it once.
 *   5. At 10 chips every Quote message action is disabled with an explanation,
 *      and removing a chip enables them again.
 *   6. Adding, removing, and refusing a quote is announced politely.
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
import { quoteChips, quoteMessageButtons } from './chat-quote-test-support.ts';

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

function conversationOf(id: string, replies: readonly string[]) {
  let conversation = appendUserMessage(createConversationHistory({ id }), 'Go.');
  for (const reply of replies) conversation = appendAssistantMessage(conversation, reply);
  return conversation;
}

async function quote(container: HTMLElement, index: number): Promise<void> {
  await fireEvent.click(quoteMessageButtons(container)[index]!);
  await tick();
}

function removeButton(chip: HTMLElement): HTMLButtonElement {
  return chip.querySelector<HTMLButtonElement>('button[data-quote-remove]')!;
}

describe('Chat quote chips', () => {
  test('shows the first 80 characters of a quote with a Remove button', async () => {
    const text = `${'a'.repeat(80)}${'b'.repeat(40)}`;
    const { container } = render(Chat, {
      id: 'chat-chip-preview',
      conversation: conversationOf('preview', [text]),
    });

    await quote(container, 0);

    const [chip] = quoteChips(container);
    expect(chip!.querySelector('.chat-quote-chip-text')!.textContent).toBe(`${'a'.repeat(80)}…`);
    expect(removeButton(chip!).textContent?.trim()).toBe(`Remove quote: ${'a'.repeat(80)}…`);
  });

  test('shows a short quote whole, without an ellipsis', async () => {
    const { container } = render(Chat, {
      id: 'chat-chip-short',
      conversation: conversationOf('short', ['Short reply.']),
    });

    await quote(container, 0);

    const [chip] = quoteChips(container);
    expect(chip!.querySelector('.chat-quote-chip-text')!.textContent).toBe('Short reply.');
  });

  test('removes only the chip whose Remove button was activated', async () => {
    const { container } = render(Chat, {
      id: 'chat-chip-remove',
      conversation: conversationOf('remove', ['Alpha reply.', 'Beta reply.']),
    });
    await quote(container, 0);
    await quote(container, 1);
    expect(quoteChips(container)).toHaveLength(2);

    await fireEvent.click(removeButton(quoteChips(container)[0]!));
    await tick();

    const remaining = quoteChips(container);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.textContent).toContain('Beta reply.');
  });

  test('moves focus to the next Remove button, then to the composer, when a chip goes', async () => {
    const { container } = render(Chat, {
      id: 'chat-chip-focus',
      conversation: conversationOf('focus', ['Alpha reply.', 'Beta reply.']),
    });
    await quote(container, 0);
    await quote(container, 1);

    const first = removeButton(quoteChips(container)[0]!);
    first.focus();
    await fireEvent.click(first);
    await tick();
    const last = removeButton(quoteChips(container)[0]!);
    expect(document.activeElement).toBe(last);

    await fireEvent.click(last);
    await tick();
    expect(document.activeElement).toBe(
      container.querySelector<HTMLTextAreaElement>('textarea.chat-input-editor'),
    );
    expect(quoteChips(container)).toHaveLength(0);
  });

  test('keeps chips in the order the quotes were added', async () => {
    const { container } = render(Chat, {
      id: 'chat-chip-order',
      conversation: conversationOf('order', ['First reply.', 'Second reply.', 'Third reply.']),
    });

    await quote(container, 2);
    await quote(container, 0);
    await quote(container, 1);

    expect(quoteChips(container).map((chip) => chip.textContent?.trim())).toEqual([
      expect.stringContaining('Third reply.'),
      expect.stringContaining('First reply.'),
      expect.stringContaining('Second reply.'),
    ]);
  });

  test('adds identical text once', async () => {
    const { container } = render(Chat, {
      id: 'chat-chip-dedupe',
      conversation: conversationOf('dedupe', ['Same words.', 'Same words.']),
    });

    await quote(container, 0);
    await quote(container, 0);
    await quote(container, 1);

    expect(quoteChips(container)).toHaveLength(1);
  });

  test('disables every Quote action at ten chips and says why, until one is removed', async () => {
    const replies = Array.from({ length: 11 }, (_, index) => `Reply number ${index + 1}.`);
    const { container } = render(Chat, {
      id: 'chat-chip-limit',
      conversation: conversationOf('limit', replies),
    });

    for (let index = 0; index < 10; index += 1) await quote(container, index);
    expect(quoteChips(container)).toHaveLength(10);

    const buttons = quoteMessageButtons(container);
    expect(buttons.every((button) => button.disabled)).toBe(true);
    const explanation = document.getElementById(
      buttons[10]!.getAttribute('aria-describedby') ?? '',
    );
    expect(explanation?.textContent).toContain('10');

    // A disabled Quote cannot add an eleventh chip.
    await fireEvent.click(buttons[10]!);
    await tick();
    expect(quoteChips(container)).toHaveLength(10);

    await fireEvent.click(removeButton(quoteChips(container)[0]!));
    await tick();
    expect(quoteMessageButtons(container).every((button) => !button.disabled)).toBe(true);
    expect(buttons[10]!.hasAttribute('aria-describedby')).toBe(false);
  });

  test('announces added, removed and repeated quotes', async () => {
    const { container } = render(Chat, {
      id: 'chat-chip-announce',
      conversation: conversationOf('announce', ['Announce me.']),
    });
    const liveText = (): string =>
      Array.from(container.querySelectorAll('[aria-live="polite"]'))
        .map((region) => region.textContent ?? '')
        .join(' ');

    await quote(container, 0);
    expect(liveText()).toContain('Quote added');

    await quote(container, 0);
    expect(liveText()).toContain('already quoted');

    await fireEvent.click(removeButton(quoteChips(container)[0]!));
    await tick();
    expect(liveText()).toContain('Quote removed');
  });
});
