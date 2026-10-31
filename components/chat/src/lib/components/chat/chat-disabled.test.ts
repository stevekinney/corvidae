/**
 * `disabled` stops the composer while the host cannot take a message (the server is unreachable or
 * the chat is disconnected): typed text stays readable, Send and Enter do nothing, and the rest of
 * the chat is still usable.
 */

/// <reference lib="dom" />
import { afterAll, afterEach, describe, expect, test } from 'bun:test';

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

const { render, fireEvent, cleanup } = await import('@testing-library/svelte');
const { tick } = await import('svelte');
const { default: Chat } = await import('./chat.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function composerOf(container: HTMLElement): HTMLTextAreaElement {
  return container.querySelector<HTMLTextAreaElement>('textarea.chat-input-editor')!;
}

describe('Chat disabled', () => {
  test('disables the composer, keeps the typed text, and sends nothing', async () => {
    const sent: unknown[] = [];
    const conversation = appendUserMessage(createConversationHistory({ id: 'off' }), 'hello');
    const { container, rerender } = render(Chat, {
      id: 'off',
      conversation,
      onSubmit: (event: unknown) => sent.push(event),
    });
    await tick();
    expect(composerOf(container).disabled).toBe(false);

    await fireEvent.input(composerOf(container), { target: { value: 'draft text' } });
    await rerender({ disabled: true });
    await tick();

    const composer = composerOf(container);
    expect(composer.disabled).toBe(true);
    expect(composer.value).toBe('draft text');
    await fireEvent.keyDown(composer, { key: 'Enter' });
    const send = container.querySelector<HTMLButtonElement>('button.chat-input-send');
    if (send !== null) {
      expect(send.disabled).toBe(true);
      await fireEvent.click(send);
    }
    await tick();
    expect(sent).toEqual([]);
    expect(composerOf(container).value).toBe('draft text');
  });
});
