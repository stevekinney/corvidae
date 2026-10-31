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
    expect(composerOf(container).readOnly).toBe(false);

    composerOf(container).focus();
    await fireEvent.input(composerOf(container), { target: { value: 'draft text' } });
    await rerender({ disabled: true });
    await tick();

    const composer = composerOf(container);
    expect(composer.readOnly).toBe(true);
    expect(document.activeElement).toBe(composer);
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
    expect(document.activeElement).toBe(composerOf(container));

    await rerender({ disabled: false });
    await tick();
    expect(composerOf(container).readOnly).toBe(false);
    expect(document.activeElement).toBe(composerOf(container));
    await fireEvent.keyDown(composerOf(container), { key: 'Enter' });
    await tick();
    expect(sent).toHaveLength(1);
  });
});
