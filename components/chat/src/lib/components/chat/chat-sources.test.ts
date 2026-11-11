/**
 * COR-2257: the sources behind assistant messages (`sourcesByMessageId`), shown through Cinder's
 * Citation.
 *
 * Asserts:
 *   1. Without a map, the transcript renders no Sources control.
 *   2. Only an assistant message with sources gets a control; one without, and a user message
 *      given the same input, get none. Empty arrays and unknown ids are ignored.
 *   3. The panel keeps the supplied order and labels, keeps duplicates, lists a text-only source,
 *      and links only a safe web address.
 *   4. Changing the controlled map removes a message's control.
 *   5. Removing the sources while focus is on the control moves focus to the message.
 *   6. The conversation passed in is never changed.
 */

/// <reference lib="dom" />
import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import type { CitationSource } from '@lostgradient/cinder';
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

const { render, fireEvent, cleanup, waitFor } = await import('@testing-library/svelte');
const { tick } = await import('svelte');
const { default: Chat } = await import('./chat.svelte');

type TestConversation = import('./conversation-model.ts').ConversationHistory;
type TestRole = import('./conversation-model.ts').MessageRole;

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function createConversation(): TestConversation {
  const now = new Date().toISOString();
  return {
    schemaVersion: 4,
    id: 'sources-test',
    status: 'active',
    metadata: {},
    ids: [],
    messages: {},
    createdAt: now,
    updatedAt: now,
  };
}

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

/** A user question, assistant A (with sources), a second question and assistant B (without). */
function sourcedConversation(): TestConversation {
  let conversation = createConversation();
  conversation = appendMessage(conversation, 'user', 'What changed this year?', 'user-1');
  conversation = appendMessage(conversation, 'assistant', 'Revenue rose.', 'assistant-a');
  conversation = appendMessage(conversation, 'user', 'And costs?', 'user-2');
  conversation = appendMessage(conversation, 'assistant', 'Costs fell.', 'assistant-b');
  return conversation;
}

const sourcesForA: readonly CitationSource[] = [
  { label: 'Annual report', url: 'https://example.com/annual', detail: 'Revenue rose 12%.' },
  { label: 'Board minutes' },
  { label: 'Annual report', url: 'https://example.com/annual', detail: 'Revenue rose 12%.' },
  { label: 'Unsafe source', url: 'javascript:alert(1)' },
];

function messageArticle(container: HTMLElement, id: string): HTMLElement {
  return container.querySelector<HTMLElement>(`article[data-message-id="${id}"]`)!;
}

function sourcesControl(container: HTMLElement, id: string): HTMLButtonElement | null {
  return messageArticle(container, id).querySelector<HTMLButtonElement>(
    '.chat-message-sources .cinder-citation__marker',
  );
}

describe('Chat — sourcesByMessageId', () => {
  test('without a map, no message shows a Sources control', async () => {
    const { container } = render(Chat, { id: 'sources-none', conversation: sourcedConversation() });
    await tick();

    expect(container.querySelectorAll('article[data-message-id]')).toHaveLength(4);
    expect(container.querySelector('.chat-message-sources')).toBeNull();
    expect(container.querySelector('.cinder-citation')).toBeNull();
  });

  test('only the assistant message with sources shows the control', async () => {
    const sourcesByMessageId = new Map<string, readonly CitationSource[]>([
      ['assistant-a', sourcesForA],
      ['assistant-b', []],
      ['user-1', sourcesForA],
      ['missing-message', sourcesForA],
    ]);
    const { container } = render(Chat, {
      id: 'sources-only-a',
      conversation: sourcedConversation(),
      sourcesByMessageId,
    });
    await tick();

    expect(container.querySelectorAll('.chat-message-sources')).toHaveLength(1);
    const control = sourcesControl(container, 'assistant-a');
    expect(control?.getAttribute('aria-label')).toBe('Sources (4)');
    expect(control?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Sources 4');
    expect(sourcesControl(container, 'assistant-b')).toBeNull();
    expect(sourcesControl(container, 'user-1')).toBeNull();
  });

  test('the panel keeps the supplied order, labels and duplicates, and links only safe addresses', async () => {
    const { container } = render(Chat, {
      id: 'sources-panel',
      conversation: sourcedConversation(),
      sourcesByMessageId: new Map([['assistant-a', sourcesForA]]),
    });
    await tick();

    await fireEvent.click(sourcesControl(container, 'assistant-a')!);
    await waitFor(() =>
      expect(document.querySelector('.cinder-citation__panel ol')).not.toBeNull(),
    );

    const items = Array.from(document.querySelectorAll('.cinder-citation__panel ol > li'));
    expect(items.map((item) => item.querySelector('strong')?.textContent)).toEqual([
      'Annual report',
      'Board minutes',
      'Annual report',
      'Unsafe source',
    ]);
    expect(items[1]?.querySelector('a')).toBeNull();
    expect(items[1]?.querySelector('.cinder-citation__note')?.textContent).toBe(
      'Internal document, no public link',
    );
    expect(items[3]?.querySelector('a')).toBeNull();
    expect(
      Array.from(document.querySelectorAll('.cinder-citation__panel a')).map((link) =>
        link.getAttribute('href'),
      ),
    ).toEqual(['https://example.com/annual', 'https://example.com/annual']);
  });

  test('changing the controlled map removes the control', async () => {
    const { container, rerender } = render(Chat, {
      id: 'sources-change',
      conversation: sourcedConversation(),
      sourcesByMessageId: new Map([['assistant-a', sourcesForA]]),
    });
    await tick();
    expect(sourcesControl(container, 'assistant-a')).not.toBeNull();

    await rerender({ sourcesByMessageId: new Map([['assistant-a', []]]) });
    await tick();
    expect(sourcesControl(container, 'assistant-a')).toBeNull();

    await rerender({ sourcesByMessageId: new Map([['assistant-a', sourcesForA.slice(0, 1)]]) });
    await tick();
    expect(sourcesControl(container, 'assistant-a')?.getAttribute('aria-label')).toBe(
      'Sources (1)',
    );

    await rerender({ sourcesByMessageId: undefined });
    await tick();
    expect(container.querySelector('.chat-message-sources')).toBeNull();
  });

  test('removing the sources while their control has focus moves focus to the message', async () => {
    const { container, rerender } = render(Chat, {
      id: 'sources-focus',
      conversation: sourcedConversation(),
      sourcesByMessageId: new Map([['assistant-a', sourcesForA]]),
    });
    await tick();
    const control = sourcesControl(container, 'assistant-a')!;
    control.focus();
    expect(document.activeElement).toBe(control);

    await rerender({ sourcesByMessageId: new Map() });
    await tick();
    await tick();

    expect(control.isConnected).toBe(false);
    expect(document.activeElement).toBe(messageArticle(container, 'assistant-a'));
  });

  test('never changes the conversation it is given', async () => {
    const conversation = sourcedConversation();
    const snapshot = JSON.stringify(conversation);
    const { container } = render(Chat, {
      id: 'sources-immutable',
      conversation,
      sourcesByMessageId: new Map([['assistant-a', sourcesForA]]),
    });
    await tick();
    await fireEvent.click(sourcesControl(container, 'assistant-a')!);
    await tick();

    expect(JSON.stringify(conversation)).toBe(snapshot);
  });
});
