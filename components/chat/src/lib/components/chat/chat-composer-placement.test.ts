/**
 * `composerPlacement` and `composerFooter`: a new chat centers its empty state, composer and the
 * host's next steps as one block, and docks the composer once the conversation has a message.
 *
 * Asserts:
 *   1. By default the composer is docked and no footer is drawn.
 *   2. `composerPlacement="centered"` marks the container while the conversation is empty.
 *   3. The centered mark goes once the conversation has a message, and the footer stays.
 *   4. `composerFooter` is drawn inside the composer's area, after the composer and its hint.
 */

/// <reference lib="dom" />
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { createRawSnippet } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';
import { appendUserMessage, createConversationHistory } from './builders.ts';

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

const footer = createRawSnippet(() => ({
  render: () => '<p data-testid="composer-footer-content">Try something</p>',
}));

function placementOf(container: HTMLElement): string | null {
  return (
    container.querySelector('.chat-container')?.getAttribute('data-composer-placement') ?? null
  );
}

describe('Chat composer placement and footer', () => {
  test('docks the composer and draws no footer by default', () => {
    const { container } = render(Chat, {
      id: 'chat-placement-default',
      conversation: createConversationHistory({ id: 'default' }),
    });

    expect(placementOf(container)).toBe('docked');
    expect(container.querySelector('.chat-composer-footer')).toBeNull();
  });

  test('centers an empty conversation when asked to', () => {
    const { container } = render(Chat, {
      id: 'chat-placement-centered',
      conversation: createConversationHistory({ id: 'centered' }),
      composerPlacement: 'centered',
    });

    expect(placementOf(container)).toBe('centered');
  });

  test('docks again once the conversation has a message, and keeps the footer', () => {
    const { container } = render(Chat, {
      id: 'chat-placement-said',
      conversation: appendUserMessage(createConversationHistory({ id: 'said' }), 'hello'),
      composerPlacement: 'centered',
      composerFooter: footer,
    });

    expect(placementOf(container)).toBe('docked');
    expect(container.querySelector('[data-testid="composer-footer-content"]')).not.toBeNull();
  });

  test('draws the footer in the composer area, after the composer and its hint', () => {
    const { container } = render(Chat, {
      id: 'chat-placement-footer',
      conversation: createConversationHistory({ id: 'footer' }),
      composerPlacement: 'centered',
      composerFooter: footer,
      composerHint: 'Use the shortcut to send',
    });

    const area = container.querySelector('.chat-input-area')!;
    const drawn = area.querySelector('.chat-composer-footer')!;
    expect(drawn.textContent).toBe('Try something');
    const hint = area.querySelector('.chat-input-hint')!;
    expect(hint.compareDocumentPosition(drawn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
