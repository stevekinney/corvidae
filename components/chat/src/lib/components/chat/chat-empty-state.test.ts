/**
 * The default empty state of a conversation with no message is Cinder's first-use `EmptyState`
 * (COR-2285, row V1): an icon tile, a title, the agent's description and the suggested prompts as
 * buttons that send through the normal message path.
 */

/// <reference lib="dom" />
import { afterAll, afterEach, describe, expect, test } from 'bun:test';

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

const { render, fireEvent, cleanup } = await import('@testing-library/svelte');
const { default: Chat } = await import('./chat.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('the default empty state', () => {
  test('is a first-use empty state with an icon tile and the default title', () => {
    const { container } = render(Chat, {
      props: { id: 'empty-default', conversation: createConversationHistory({ id: 'empty-1' }) },
    });

    const state = container.querySelector('.chat-empty .cinder-empty-state');
    expect(state).not.toBeNull();
    expect(state!.getAttribute('data-cinder-kind')).toBe('first-use');
    expect(state!.querySelector('.cinder-empty-state-icon svg')).not.toBeNull();
    expect(state!.querySelector('h2.cinder-empty-state-title')?.textContent?.trim()).toBe(
      'No messages yet',
    );
    // No description and no prompts: nothing else is drawn.
    expect(state!.querySelector('.cinder-empty-state-description')).toBeNull();
    expect(state!.querySelector('.cinder-empty-state-action')).toBeNull();
  });

  test('says the host title and the agent description', () => {
    const { container } = render(Chat, {
      props: {
        id: 'empty-words',
        conversation: createConversationHistory({ id: 'empty-2' }),
        emptyTitle: 'Ask Release helper',
        emptyDescription: 'Drafts release notes from merged pull requests.',
      },
    });

    const state = container.querySelector('.chat-empty .cinder-empty-state')!;
    expect(state.querySelector('.cinder-empty-state-title')?.textContent?.trim()).toBe(
      'Ask Release helper',
    );
    expect(state.querySelector('.cinder-empty-state-description')?.textContent?.trim()).toBe(
      'Drafts release notes from merged pull requests.',
    );
  });

  test('draws the suggested prompts as buttons in the empty state, and one sends its words', async () => {
    const submitted: string[] = [];
    const { container } = render(Chat, {
      props: {
        id: 'empty-prompts',
        conversation: createConversationHistory({ id: 'empty-3' }),
        emptyPrompts: ['Summarize this', 'Explain like I am five'],
        onSubmit: (event: { message: { content: unknown } }) => {
          submitted.push(String(event.message.content));
        },
      },
    });

    const group = container.querySelector(
      '.cinder-empty-state-action [role="group"][aria-label="Suggested prompts"]',
    )!;
    const buttons = [...group.querySelectorAll<HTMLButtonElement>('button.chat-empty-prompt')];
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      'Summarize this',
      'Explain like I am five',
    ]);

    await fireEvent.click(buttons[1]!);
    expect(submitted).toEqual(['Explain like I am five']);
  });
});
