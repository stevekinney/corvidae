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

/**
 * COR-2327: the docked composer area (the composer, and the approval reminder and blocked row
 * stacked above it) marks itself with Cinder's `dockedToBottom()`, so a toast sits above it rather
 * than over it. A centred composer sits in the middle of the surface and is not counted.
 */
describe('Chat composer area and the toast region', () => {
  const DOCKED_PROPERTY = '--_cinder-docked-action-bar-height';
  const originalRect = HTMLElement.prototype.getBoundingClientRect;

  afterEach(() => {
    HTMLElement.prototype.getBoundingClientRect = originalRect;
    document.documentElement.style.removeProperty(DOCKED_PROPERTY);
  });

  /** happy-dom lays nothing out: the composer area is given a 150px box at the viewport's bottom. */
  function layOutComposerAtTheBottom(): void {
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (!this.classList.contains('chat-input-area')) return originalRect.call(this);
      const bottom = window.innerHeight;
      return { top: bottom - 150, bottom, height: 150 } as DOMRect;
    };
  }

  test('a docked composer area lifts the toasts above its top, and stops when it unmounts', () => {
    layOutComposerAtTheBottom();
    const { unmount } = render(Chat, {
      id: 'chat-placement-toasts',
      conversation: appendUserMessage(createConversationHistory({ id: 'toasts' }), 'hello'),
    });

    expect(document.documentElement.style.getPropertyValue(DOCKED_PROPERTY)).toBe('150px');
    unmount();
    expect(document.documentElement.style.getPropertyValue(DOCKED_PROPERTY)).toBe('');
  });

  test('a centred composer is not counted', () => {
    layOutComposerAtTheBottom();
    render(Chat, {
      id: 'chat-placement-centered-toasts',
      conversation: createConversationHistory({ id: 'centered-toasts' }),
      composerPlacement: 'centered',
    });

    expect(document.documentElement.style.getPropertyValue(DOCKED_PROPERTY)).toBe('');
  });
});
