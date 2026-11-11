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

    await waitFor(() =>
      expect(document.activeElement === messageArticle(container, 'assistant-a')).toBe(true),
    );
    expect(control.isConnected).toBe(false);
  });

  test('removing the sources while the message is inert behind their sheet still moves focus to the message', async () => {
    const { container, rerender } = render(Chat, {
      id: 'sources-inert',
      conversation: sourcedConversation(),
      sourcesByMessageId: new Map([['assistant-a', sourcesForA]]),
    });
    await tick();
    const control = sourcesControl(container, 'assistant-a')!;
    control.focus();
    const article = messageArticle(container, 'assistant-a');
    const timeline = container.querySelector<HTMLElement>('.chat-timeline')!;
    // A narrow screen's sheet is a modal dialog, which makes the message inert: the first focus
    // call does nothing, and Chat's timeline backstop takes the focus the removal orphans.
    const focus = article.focus.bind(article);
    let calls = 0;
    article.focus = (options?: FocusOptions) => {
      calls += 1;
      if (calls === 1) {
        timeline.focus();
        return;
      }
      focus(options);
    };

    await rerender({ sourcesByMessageId: new Map() });

    await waitFor(() => expect(document.activeElement === article).toBe(true));
    expect(calls).toBeGreaterThan(1);
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

// COR-2259: `sourcePresentation="list"` shows the same sources as a disclosure under the message.
describe('Chat — sourcePresentation="list"', () => {
  function listToggle(container: HTMLElement, id: string): HTMLButtonElement | null {
    return messageArticle(container, id).querySelector<HTMLButtonElement>(
      '.chat-message-sources-toggle',
    );
  }

  function sourceList(container: HTMLElement, id: string): HTMLElement | null {
    return messageArticle(container, id).querySelector<HTMLElement>('.chat-message-sources-list');
  }

  test('only the assistant message with sources shows one collapsed control and its count', async () => {
    const { container } = render(Chat, {
      id: 'sources-list-collapsed',
      conversation: sourcedConversation(),
      sourcesByMessageId: new Map([
        ['assistant-a', sourcesForA],
        ['user-1', sourcesForA],
      ]),
      sourcePresentation: 'list',
    });
    await tick();

    expect(container.querySelectorAll('.chat-message-sources-toggle')).toHaveLength(1);
    expect(container.querySelector('.cinder-citation')).toBeNull();
    const toggle = listToggle(container, 'assistant-a')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-label')).toBe('Sources (4)');
    expect(toggle.textContent?.replace(/\s+/g, ' ').trim()).toBe('Sources 4');
    expect(sourceList(container, 'assistant-a')).toBeNull();
    expect(listToggle(container, 'assistant-b')).toBeNull();
    expect(listToggle(container, 'user-1')).toBeNull();
  });

  test('opening the list shows every source in order, with excerpts and only safe links', async () => {
    const { container } = render(Chat, {
      id: 'sources-list-open',
      conversation: sourcedConversation(),
      sourcesByMessageId: new Map([['assistant-a', sourcesForA]]),
      sourcePresentation: 'list',
    });
    await tick();
    const toggle = listToggle(container, 'assistant-a')!;
    await fireEvent.click(toggle);
    await tick();

    const list = sourceList(container, 'assistant-a')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBe(list.id);
    const items = Array.from(list.querySelectorAll('li'));
    expect(items.map((item) => item.querySelector('strong')?.textContent)).toEqual([
      'Annual report',
      'Board minutes',
      'Annual report',
      'Unsafe source',
    ]);
    expect(items[0]?.querySelector('p')?.textContent).toBe('Revenue rose 12%.');
    expect(items[0]?.querySelector('strong')?.getAttribute('dir')).toBe('auto');
    expect(items[1]?.querySelector('a')).toBeNull();
    expect(items[1]?.querySelector('.chat-message-sources-note')?.textContent).toBe(
      'Internal document, no public link',
    );
    expect(items[3]?.querySelector('a')).toBeNull();
    expect(items[3]?.querySelector('.chat-message-sources-note')?.textContent).toBe(
      "Link hidden: the address isn't a safe web link",
    );
    const links = Array.from(list.querySelectorAll('a'));
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      'https://example.com/annual',
      'https://example.com/annual',
    ]);
    expect(links[0]?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Open example.com ↗');
  });

  test('closing the list keeps focus on its control', async () => {
    const { container } = render(Chat, {
      id: 'sources-list-close',
      conversation: sourcedConversation(),
      sourcesByMessageId: new Map([['assistant-a', sourcesForA]]),
      sourcePresentation: 'list',
    });
    await tick();
    const toggle = listToggle(container, 'assistant-a')!;
    toggle.focus();
    await fireEvent.click(toggle);
    await tick();
    expect(sourceList(container, 'assistant-a')).not.toBeNull();

    await fireEvent.click(toggle);
    await tick();
    expect(sourceList(container, 'assistant-a')).toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);
  });

  test('removing the sources while focus is in the open list moves focus to the message', async () => {
    const { container, rerender } = render(Chat, {
      id: 'sources-list-remove',
      conversation: sourcedConversation(),
      sourcesByMessageId: new Map([['assistant-a', sourcesForA]]),
      sourcePresentation: 'list',
    });
    await tick();
    await fireEvent.click(listToggle(container, 'assistant-a')!);
    await tick();
    const link = sourceList(container, 'assistant-a')!.querySelector<HTMLAnchorElement>('a')!;
    link.focus();
    expect(document.activeElement).toBe(link);

    await rerender({ sourcesByMessageId: new Map([['assistant-b', sourcesForA]]) });

    await waitFor(() =>
      expect(document.activeElement === messageArticle(container, 'assistant-a')).toBe(true),
    );
    expect(listToggle(container, 'assistant-a')).toBeNull();
    expect(sourceList(container, 'assistant-a')).toBeNull();
  });
});

// COR-2281 M4: `sourcePresentation="inline"` draws one chip per source in the line, each reading
// the source's host, or its label when it has no safe web address.
describe('Chat — sourcePresentation="inline"', () => {
  function chips(container: HTMLElement, id: string): HTMLButtonElement[] {
    return Array.from(
      messageArticle(container, id).querySelectorAll<HTMLButtonElement>(
        '.chat-message-source-chips .cinder-citation__marker',
      ),
    );
  }

  test('withdrawing an open inline source closes its panel and focuses a message action', async () => {
    const { container, rerender } = render(Chat, {
      id: 'sources-inline-withdrawal',
      conversation: sourcedConversation(),
      sourcePresentation: 'inline',
      sourcesByMessageId: new Map([['assistant-a', sourcesForA.slice(0, 2)]]),
    });
    await tick();
    const article = messageArticle(container, 'assistant-a');
    const markers = article.querySelectorAll<HTMLButtonElement>('.cinder-citation__marker');
    const removed = markers[0]!;
    const remaining = markers[1]!;
    removed.focus();
    await fireEvent.click(removed);
    await waitFor(() => expect(document.querySelector('.cinder-citation__panel')).not.toBeNull());

    await rerender({
      sourcesByMessageId: new Map([['assistant-a', sourcesForA.slice(1, 2)]]),
    });

    await waitFor(() =>
      expect(document.activeElement === container.querySelector('[data-citation-focus]')).toBe(
        true,
      ),
    );
    expect(document.activeElement?.classList.contains('chat-message-copy')).toBe(true);
    expect(removed.isConnected).toBe(false);
    expect(remaining.isConnected).toBe(true);
    expect(document.querySelector('.cinder-citation__panel')).toBeNull();
    expect(
      Array.from(container.querySelectorAll('[role="status"]')).filter(
        (region) => region.textContent?.trim() === 'Sources were removed',
      ),
    ).toHaveLength(1);
  });

  test('only the assistant message with sources shows chips, and no Sources control', async () => {
    const { container } = render(Chat, {
      id: 'sources-inline-only',
      conversation: sourcedConversation(),
      sourcesByMessageId: new Map([
        ['assistant-a', sourcesForA],
        ['user-1', sourcesForA],
      ]),
      sourcePresentation: 'inline',
    });
    await tick();

    expect(container.querySelectorAll('.chat-message-source-chips')).toHaveLength(1);
    expect(container.querySelector('.chat-message-sources-toggle')).toBeNull();
    expect(container.querySelector('.chat-message-sources-citation')).toBeNull();
    expect(chips(container, 'assistant-a')).toHaveLength(4);
    expect(chips(container, 'assistant-b')).toHaveLength(0);
    expect(chips(container, 'user-1')).toHaveLength(0);
    expect(
      messageArticle(container, 'assistant-a')
        .querySelector('.chat-message-source-chips')
        ?.getAttribute('role'),
    ).toBe('group');
  });

  test('coarse pointers use one compact Sources marker instead of a touch-target wall', async () => {
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string) => ({
        matches: query === '(pointer: coarse)',
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }),
    });
    try {
      const { container, rerender } = render(Chat, {
        id: 'sources-inline-coarse',
        conversation: sourcedConversation(),
        sourcesByMessageId: new Map([['assistant-a', sourcesForA]]),
        sourcePresentation: 'inline',
      });
      await tick();

      const article = messageArticle(container, 'assistant-a');
      expect(article.querySelector('.chat-message-source-chips')).toBeNull();
      const compact = article.querySelector<HTMLButtonElement>(
        '.chat-message-sources-citation .cinder-citation__marker',
      );
      expect(compact?.getAttribute('aria-label')).toBe('Sources (4)');
      compact?.focus();
      expect(document.activeElement).toBe(compact);

      await rerender({ sourcesByMessageId: new Map() });
      await waitFor(() => expect(document.activeElement === article).toBe(true));
    } finally {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: originalMatchMedia,
      });
    }
  });

  test('each chip disambiguates same-host sources with their supplied labels', async () => {
    const ambiguousSources: readonly CitationSource[] = [
      { label: 'Annual report', url: 'https://example.com/annual' },
      { label: 'Board minutes' },
      { label: 'Audit appendix', url: 'https://example.com/audit' },
      { label: 'Unsafe source', url: 'javascript:alert(1)' },
    ];
    const { container } = render(Chat, {
      id: 'sources-inline-labels',
      conversation: sourcedConversation(),
      sourcesByMessageId: new Map([['assistant-a', ambiguousSources]]),
      sourcePresentation: 'inline',
    });
    await tick();

    expect(chips(container, 'assistant-a').map((chip) => chip.textContent?.trim())).toEqual([
      'Annual report',
      'Board minutes',
      'Audit appendix',
      'Unsafe source',
    ]);
    // The text is drawn with its own direction, so a right-to-left label stays readable.
    expect(
      chips(container, 'assistant-a')[0]
        ?.querySelector('.chat-message-source-chip-text')
        ?.getAttribute('dir'),
    ).toBe('auto');
  });

  test('a chip opens its own source in Citation’s panel, through the same link policy', async () => {
    const { container } = render(Chat, {
      id: 'sources-inline-panel',
      conversation: sourcedConversation(),
      sourcesByMessageId: new Map([['assistant-a', sourcesForA]]),
      sourcePresentation: 'inline',
    });
    await tick();

    await fireEvent.click(chips(container, 'assistant-a')[0]!);
    await waitFor(() => expect(document.querySelector('.cinder-citation__panel')).not.toBeNull());
    const panel = document.querySelector('.cinder-citation__panel')!;
    expect(panel.querySelector('strong')?.textContent).toBe('Annual report');
    expect(panel.querySelector('p')?.textContent).toBe('Revenue rose 12%.');
    expect(panel.querySelector('a')?.getAttribute('href')).toBe('https://example.com/annual');
  });

  test('withdrawing the source of an open chip closes its panel, moves focus to the next chip and says so once (C#11)', async () => {
    const { container, rerender } = render(Chat, {
      id: 'sources-inline-withdraw',
      conversation: sourcedConversation(),
      sourcesByMessageId: new Map([['assistant-a', sourcesForA]]),
      sourcePresentation: 'inline',
    });
    await tick();
    const minutes = chips(container, 'assistant-a')[1]!;
    minutes.focus();
    await fireEvent.click(minutes);
    await waitFor(() => expect(document.querySelector('.cinder-citation__panel')).not.toBeNull());

    const withdrawn = sourcesForA.filter((_source, index) => index !== 1);
    await rerender({ sourcesByMessageId: new Map([['assistant-a', withdrawn]]) });

    // The panel goes with its chip; it is never handed to the source after it.
    await waitFor(() =>
      expect(document.querySelector('.cinder-citation__panel')?.outerHTML ?? null).toBeNull(),
    );
    expect(minutes.isConnected).toBe(false);
    const remaining = chips(container, 'assistant-a');
    expect(remaining.map((chip) => chip.textContent?.trim())).toEqual([
      'example.com',
      'example.com',
      'Unsafe source',
    ]);
    await waitFor(() => expect(document.activeElement === remaining[1]).toBe(true));
    // Said once, through Chat's announcer outside the transcript's log, never by a region in it.
    const log = container.querySelector('[role="log"]')!;
    expect(log.textContent).not.toContain('A source was withdrawn.');
    await waitFor(() =>
      expect(
        [...container.querySelectorAll('[aria-live="polite"]')].filter(
          (region) => region.textContent?.trim() === 'A source was withdrawn.',
        ).length,
      ).toBe(1),
    );
  });

  test('removing the sources while a chip has focus moves focus to the message', async () => {
    const { container, rerender } = render(Chat, {
      id: 'sources-inline-focus',
      conversation: sourcedConversation(),
      sourcesByMessageId: new Map([['assistant-a', sourcesForA]]),
      sourcePresentation: 'inline',
    });
    await tick();
    const chip = chips(container, 'assistant-a')[2]!;
    chip.focus();
    expect(document.activeElement).toBe(chip);

    await rerender({ sourcesByMessageId: new Map() });

    await waitFor(() =>
      expect(document.activeElement === messageArticle(container, 'assistant-a')).toBe(true),
    );
    expect(chip.isConnected).toBe(false);
  });
});
