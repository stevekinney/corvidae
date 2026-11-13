/**
 * `composerLead`, `composerStarting` and `clearComposerOnSubmit`: a new chat's note above the
 * composer, and the first message while it is being started.
 *
 * Asserts:
 *   1. `composerLead` is drawn in the composer's area before the composer, live or blocked.
 *   2. While `composerStarting` is set Send exposes that word as its accessible name and tooltip,
 *      is disabled, shows only a spinner, offers no Stop, and the composer is marked busy; without
 *      it Send is Send.
 *   3. `clearComposerOnSubmit={false}` keeps the typed text after Send, and the default empties it.
 */

/// <reference lib="dom" />
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { createRawSnippet, tick } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';
import { createConversationHistory } from './builders.ts';

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

const lead = createRawSnippet(() => ({
  render: () => '<p data-testid="composer-lead-content">Starting from Workflows</p>',
}));

describe('Chat composerLead', () => {
  test('is drawn in the composer area before the composer', () => {
    const { container } = render(Chat, {
      id: 'chat-lead',
      conversation: createConversationHistory({ id: 'lead' }),
      composerLead: lead,
    });

    const area = container.querySelector('.chat-input-area')!;
    const drawn = area.querySelector('.chat-composer-lead')!;
    expect(drawn.textContent).toBe('Starting from Workflows');
    const form = area.querySelector('form.chat-input')!;
    expect(drawn.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('is drawn above the blocked row too', () => {
    const { container } = render(Chat, {
      id: 'chat-lead-blocked',
      conversation: createConversationHistory({ id: 'lead-blocked' }),
      composerLead: lead,
      composerStatus: { kind: 'blocked', reason: 'Connect a model provider to chat' },
    });

    const area = container.querySelector('.chat-input-area')!;
    const drawn = area.querySelector('.chat-composer-lead')!;
    const blocked = area.querySelector('[data-chat-composer-status="blocked"]')!;
    expect(drawn.textContent).toBe('Starting from Workflows');
    expect(drawn.compareDocumentPosition(blocked) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test('draws nothing without it', () => {
    const { container } = render(Chat, {
      id: 'chat-no-lead',
      conversation: createConversationHistory({ id: 'no-lead' }),
    });

    expect(container.querySelector('.chat-composer-lead')).toBeNull();
  });
});

describe('Chat composerStarting', () => {
  const sendButton = (container: HTMLElement) =>
    container.querySelector<HTMLButtonElement>('button[data-chat-send]')!;

  test('is Send until the host says it is starting', () => {
    const { container } = render(Chat, {
      id: 'chat-send',
      conversation: createConversationHistory({ id: 'send' }),
    });

    expect(sendButton(container).getAttribute('aria-label')).toBe('Send message');
    expect(sendButton(container).textContent?.trim()).toBe('');
    expect(container.querySelector('.chat-input-spinner')).toBeNull();
    expect(container.querySelector('form.chat-input')?.getAttribute('aria-busy')).toBeNull();
  });

  test('names the starting state accessibly with a spinner, off, and marks the composer busy', async () => {
    const { container } = render(Chat, {
      id: 'chat-starting',
      conversation: createConversationHistory({ id: 'starting' }),
      composerStarting: 'Starting chat…',
    });

    const send = sendButton(container);
    expect(send.textContent).not.toContain('Starting chat…');
    expect(send.hasAttribute('data-cinder-icon-only')).toBe(true);
    expect(send.getAttribute('aria-label')).toBe('Starting chat…');
    expect(send.disabled).toBe(true);
    expect(send.hasAttribute('data-stop')).toBe(false);
    expect(container.querySelector('.chat-input-spinner')).not.toBeNull();
    expect(container.querySelector('.chat-input-tooltip')).not.toBeNull();
    expect(container.querySelector('form.chat-input')?.getAttribute('aria-busy')).toBe('true');
    // Even with text in the box, Send stays off while the chat starts.
    const field = container.querySelector<HTMLTextAreaElement>('textarea')!;
    field.value = 'Please refund order 4471';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
    expect(sendButton(container).disabled).toBe(true);
  });
});

describe('Chat clearComposerOnSubmit', () => {
  async function submit(container: HTMLElement, text: string): Promise<HTMLTextAreaElement> {
    const field = container.querySelector<HTMLTextAreaElement>('textarea')!;
    field.value = text;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
    container
      .querySelector('form.chat-input')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await tick();
    return field;
  }

  const adapter = { sendMessage: () => Promise.resolve() };

  test('empties the box after Send by default', async () => {
    const { container } = render(Chat, {
      id: 'chat-clears',
      conversation: createConversationHistory({ id: 'clears' }),
      adapter,
    });

    const field = await submit(container, 'Say hello');
    expect(field.value).toBe('');
  });

  test('keeps the typed text after Send when it is false', async () => {
    const { container } = render(Chat, {
      id: 'chat-keeps',
      conversation: createConversationHistory({ id: 'keeps' }),
      adapter,
      clearComposerOnSubmit: false,
    });

    const field = await submit(container, 'Say hello');
    expect(field.value).toBe('Say hello');
  });
});
