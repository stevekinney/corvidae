/**
 * COR-2281 M5: the Regenerate action. Chat draws it only when the host supplies `onRegenerate`,
 * only on the latest assistant message, and hands the host that message's id. Regenerating never
 * changes the conversation Chat was given.
 */

/// <reference lib="dom" />
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

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

type TestConversation = import('./conversation-model.ts').ConversationHistory;
type TestRole = import('./conversation-model.ts').MessageRole;

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function appendMessage(
  conversation: TestConversation,
  role: TestRole,
  content: string,
  id: string,
): TestConversation {
  const now = new Date().toISOString();
  return {
    ...conversation,
    ids: [...conversation.ids, id],
    messages: {
      ...conversation.messages,
      [id]: {
        id,
        role,
        content,
        position: conversation.ids.length,
        createdAt: now,
        metadata: {},
        hidden: false,
      },
    },
    updatedAt: now,
  };
}

/** Two questions and two answers, so only the second answer is the latest. */
function answeredConversation(): TestConversation {
  const now = new Date().toISOString();
  let conversation: TestConversation = {
    schemaVersion: 4,
    id: 'regenerate-test',
    status: 'active',
    metadata: {},
    ids: [],
    messages: {},
    createdAt: now,
    updatedAt: now,
  };
  conversation = appendMessage(conversation, 'user', 'What changed this year?', 'user-1');
  conversation = appendMessage(conversation, 'assistant', 'Revenue rose.', 'assistant-a');
  conversation = appendMessage(conversation, 'user', 'And costs?', 'user-2');
  conversation = appendMessage(conversation, 'assistant', 'Costs fell.', 'assistant-b');
  return conversation;
}

function regenerateButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>('.chat-message-regenerate-button'),
  );
}

describe('Chat — onRegenerate', () => {
  test('without the callback no message offers Regenerate', async () => {
    const { container } = render(Chat, {
      id: 'regenerate-none',
      conversation: answeredConversation(),
    });
    await tick();

    expect(container.querySelectorAll('article[data-message-id]')).toHaveLength(4);
    expect(regenerateButtons(container)).toHaveLength(0);
  });

  test('only the latest assistant message offers it, and a click hands the host its id', async () => {
    const regenerate = mock((_messageId: string) => undefined);
    const { container } = render(Chat, {
      id: 'regenerate-latest',
      conversation: answeredConversation(),
      onRegenerate: regenerate,
    });
    await tick();

    const buttons = regenerateButtons(container);
    expect(buttons).toHaveLength(1);
    // The one button sits in the wrapper of the second answer.
    const latest = container.querySelector('article[data-message-id="assistant-b"]')!;
    expect(latest.closest('.chat-message-wrapper')?.contains(buttons[0]!)).toBe(true);

    await fireEvent.click(buttons[0]!);
    expect(regenerate).toHaveBeenCalledTimes(1);
    expect(regenerate).toHaveBeenCalledWith('assistant-b');
  });

  test('never changes the conversation it is given', async () => {
    const conversation = answeredConversation();
    const snapshot = JSON.stringify(conversation);
    const { container } = render(Chat, {
      id: 'regenerate-immutable',
      conversation,
      onRegenerate: () => undefined,
    });
    await tick();
    await fireEvent.click(regenerateButtons(container)[0]!);

    expect(JSON.stringify(conversation)).toBe(snapshot);
  });
});
