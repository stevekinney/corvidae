/**
 * COR-2257: the sources behind assistant messages (`sourcesByMessageId`), shown through Cinder's
 * Citation as one control on the message line.
 *
 * Asserts:
 *   1. Without a map, the transcript renders no Sources control.
 *   2. Only an assistant message with sources gets a control ("4 sources", "1 source"); one
 *      without, and a user message given the same input, get none.
 *   3. In the transcript the control is the last item of the message line and the opened list is
 *      under that line; no row of its own sits between the prose and the line.
 *   4. The list keeps the supplied order and labels, keeps duplicates, makes the whole row the link
 *      for a safe address only, and has no pager.
 *   5. Changing the controlled map removes a message's control.
 *   6. Focus: a withdrawn row hands it to the next link row, else a message action; removing every
 *      source moves it to the message.
 *   7. The conversation passed in is never changed.
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
  { label: 'Audit appendix', url: 'https://example.com/audit' },
  { label: 'Unsafe source', url: 'javascript:alert(1)' },
];

describe('claim citations in the production transcript', () => {
  test('attaches each citation to its own Markdown claim and keeps the unmapped message footer', async () => {
    const first = '[Revenue rose](https://example.com/revenue).';
    const second = '\n\nCosts **fell**.';
    let conversation = appendMessage(createConversation(), 'assistant', first + second, 'claims');
    conversation = appendMessage(conversation, 'assistant', 'The outlook improved.', 'plain');
    const before = structuredClone(conversation);
    const { container } = render(Chat, {
      id: 'claim-citations',
      conversation,
      claimSourcesByMessageId: new Map([
        [
          'claims',
          [
            { id: 'revenue', markdown: first, sources: [sourcesForA[0]!] },
            { id: 'costs', markdown: second, sources: [sourcesForA[1]!] },
          ],
        ],
      ]),
      sourcesByMessageId: new Map([
        ['claims', sourcesForA],
        ['plain', sourcesForA],
      ]),
    });
    await tick();

    const claims = [
      ...messageArticle(container, 'claims').querySelectorAll('[data-chat-cited-claim]'),
    ];
    expect(claims).toHaveLength(2);
    expect(claims[0]!.textContent).toContain('Revenue rose');
    expect(claims[0]!.querySelector('a .cinder-citation__marker')).toBeNull();
    expect(claims[1]!.textContent).toContain('fell');
    const firstMarker = claims[0]!.querySelector<HTMLButtonElement>('.cinder-citation__marker')!;
    const secondMarker = claims[1]!.querySelector<HTMLButtonElement>('.cinder-citation__marker')!;
    await fireEvent.click(firstMarker);
    await waitFor(() => expect(document.body.textContent).toContain('Annual report'));
    expect(document.body.textContent).not.toContain('Board minutes');
    await fireEvent.click(secondMarker);
    await waitFor(() => expect(document.body.textContent).toContain('Board minutes'));
    expect(sourcesControl(container, 'claims')).toBeNull();
    expect(sourcesControl(container, 'plain')).not.toBeNull();
    expect(conversation).toEqual(before);
  });

  test('renders the unchanged message and its sources when the mapping no longer matches', async () => {
    const { container } = render(Chat, {
      id: 'stale-claim-citations',
      conversation: sourcedConversation(),
      claimSourcesByMessageId: new Map([
        ['assistant-a', [{ id: 'old', markdown: 'Revenue fell.', sources: sourcesForA }]],
      ]),
      sourcesByMessageId: new Map([['assistant-a', sourcesForA]]),
    });
    await tick();
    const message = messageArticle(container, 'assistant-a');
    expect(message.textContent).toContain('Revenue rose.');
    expect(message.textContent).not.toContain('Revenue fell.');
    expect(message.querySelector('[data-chat-cited-claim]')).toBeNull();
    expect(sourcesControl(container, 'assistant-a')).not.toBeNull();
  });
});

function messageArticle(container: HTMLElement, id: string): HTMLElement {
  return container.querySelector<HTMLElement>(`article[data-message-id="${id}"]`)!;
}

function sourcesControl(container: HTMLElement, id: string): HTMLButtonElement | null {
  return (
    messageArticle(container, id).parentElement?.querySelector<HTMLButtonElement>(
      '[data-chat-sources-trigger] .cinder-citation__marker',
    ) ?? null
  );
}

function sourceRows(container: HTMLElement, id: string): HTMLElement[] {
  return Array.from(
    messageArticle(container, id).parentElement?.querySelectorAll<HTMLElement>(
      '.cinder-citation__panel .cinder-citation__item',
    ) ?? [],
  );
}

/** A phone: Cinder's phone breakpoint matches, so the list opens in the bottom sheet. */
async function onPhone<T>(run: () => Promise<T>): Promise<T> {
  const originalMatchMedia = window.matchMedia;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: query.startsWith('(width <'),
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
    return await run();
  } finally {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: originalMatchMedia,
    });
  }
}

describe('Chat — sourcesByMessageId', () => {
  test('without a map, no message shows a Sources control', async () => {
    const { container } = render(Chat, { id: 'sources-none', conversation: sourcedConversation() });
    await tick();

    expect(container.querySelectorAll('article[data-message-id]')).toHaveLength(4);
    expect(container.querySelector('.chat-message-sources')).toBeNull();
    expect(container.querySelector('.cinder-citation')).toBeNull();
  });

  test('only the assistant message with sources shows the one control, with its count and the word', async () => {
    const sourcesByMessageId = new Map<string, readonly CitationSource[]>([
      ['assistant-a', sourcesForA],
      ['assistant-b', sourcesForA.slice(0, 1)],
      ['user-1', sourcesForA],
      ['missing-message', sourcesForA],
    ]);
    const { container } = render(Chat, {
      id: 'sources-only-a',
      conversation: sourcedConversation(),
      sourcesByMessageId,
    });
    await tick();

    expect(container.querySelectorAll('.cinder-citation__marker')).toHaveLength(2);
    const control = sourcesControl(container, 'assistant-a');
    expect(control?.getAttribute('aria-label')).toBe('4 sources');
    expect(control?.textContent?.replace(/\s+/g, ' ').trim()).toBe('4 sources');
    expect(control?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(sourcesControl(container, 'assistant-b')?.textContent?.trim()).toBe('1 source');
    expect(sourcesControl(container, 'user-1')).toBeNull();
  });

  test('the control looks the same for any count', async () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ label: `Source ${index + 1}` }));
    const { container } = render(Chat, {
      id: 'sources-same-control',
      conversation: sourcedConversation(),
      sourcesByMessageId: new Map([
        ['assistant-a', many],
        ['assistant-b', many.slice(0, 2)],
      ]),
    });
    await tick();

    const first = sourcesControl(container, 'assistant-a')!;
    const second = sourcesControl(container, 'assistant-b')!;
    expect(first.className).toBe(second.className);
    expect(first.textContent?.trim()).toBe('12 sources');
    expect(second.textContent?.trim()).toBe('2 sources');
    // One control, whatever the count: no disclosure toggle and no separate link style.
    expect(container.querySelector('.chat-message-sources-toggle')).toBeNull();
    expect(container.querySelector('.chat-message-sources-link')).toBeNull();
  });

  test('puts the transcript control at the trailing end of the message line and the list under it', async () => {
    const { container } = render(Chat, {
      id: 'sources-message-line',
      conversation: sourcedConversation(),
      variant: 'transcript',
      sourcesByMessageId: new Map([['assistant-a', sourcesForA]]),
    });
    await tick();

    const article = messageArticle(container, 'assistant-a');
    const wrapper = article.parentElement!;
    const line = wrapper.querySelector<HTMLElement>('.chat-message-line')!;
    const control = sourcesControl(container, 'assistant-a')!;
    expect(line.contains(control)).toBe(true);
    // No row of its own between the prose and the line.
    expect(wrapper.querySelector(':scope > .chat-message-sources')).toBeNull();
    expect(article.nextElementSibling === line || line.compareDocumentPosition(article) > 0).toBe(
      true,
    );
    const actions = line.querySelector('.chat-message-line-actions')!;
    expect(line.firstElementChild?.tagName).toBe('TIME');
    expect(actions.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    await fireEvent.click(control);
    await tick();
    const panel = line.querySelector('.cinder-citation__panel')!;
    expect(panel).not.toBeNull();
    expect(control.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  test('opening the control lists every source in place, in order, with the whole row the link and no pager', async () => {
    const { container } = render(Chat, {
      id: 'sources-panel',
      conversation: sourcedConversation(),
      sourcesByMessageId: new Map([['assistant-a', sourcesForA]]),
    });
    await tick();

    const control = sourcesControl(container, 'assistant-a')!;
    expect(control.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.click(control);
    await tick();

    expect(control.getAttribute('aria-expanded')).toBe('true');
    const rows = sourceRows(container, 'assistant-a');
    expect(control.getAttribute('aria-controls')).toBe(
      rows[0]?.closest('.cinder-citation__panel')?.id ?? null,
    );
    expect(rows.map((row) => row.querySelector('.cinder-citation__title')?.textContent)).toEqual([
      'Annual report',
      'Board minutes',
      'Audit appendix',
      'Unsafe source',
    ]);
    const first = rows[0]!.querySelector<HTMLAnchorElement>('a.cinder-citation__row')!;
    expect(first.getAttribute('href')).toBe('https://example.com/annual');
    expect(first.querySelector('.cinder-citation__domain')?.textContent).toBe('example.com');
    expect(first.querySelector('.cinder-citation__detail')?.textContent).toBe('Revenue rose 12%.');
    expect(rows[1]?.querySelector('a')).toBeNull();
    expect(rows[1]?.querySelector('.cinder-citation__note')?.textContent).toBe(
      'Internal document, no public link',
    );
    expect(rows[3]?.querySelector('a')).toBeNull();
    expect(rows[3]?.querySelector('.cinder-citation__note')?.textContent).toBe(
      "Link hidden: the address isn't a safe web link",
    );
    expect(
      Array.from(container.querySelectorAll('.cinder-citation__panel a')).map((link) =>
        link.getAttribute('href'),
      ),
    ).toEqual(['https://example.com/annual', 'https://example.com/audit']);
    expect(container.textContent).not.toMatch(/\d of \d/);
    expect(container.querySelector('[aria-label="Next source"]')).toBeNull();

    // Closing leaves focus on the control and removes the list.
    control.focus();
    await fireEvent.click(control);
    await tick();
    expect(sourceRows(container, 'assistant-a')).toHaveLength(0);
    expect(control.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement === control).toBe(true);
  });

  test('on a phone the same list opens as the bottom sheet, not in place', async () => {
    await onPhone(async () => {
      const { container } = render(Chat, {
        id: 'sources-phone',
        conversation: sourcedConversation(),
        variant: 'transcript',
        sourcesByMessageId: new Map([['assistant-a', sourcesForA]]),
      });
      await tick();
      const control = sourcesControl(container, 'assistant-a')!;
      expect(control.getAttribute('aria-controls')).toBeNull();
      await fireEvent.click(control);

      await waitFor(() => expect(document.querySelector('.cinder-popover__sheet')).not.toBeNull());
      const sheetRows = document.querySelectorAll('.cinder-popover__sheet .cinder-citation__item');
      expect(sheetRows).toHaveLength(4);
      // The list is the sheet's, not a panel in place under the line.
      expect(
        container
          .querySelector('.chat-message-line .cinder-citation__panel')
          ?.closest('.cinder-popover__sheet') !== null,
      ).toBe(true);
    });
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
    expect(sourcesControl(container, 'assistant-a')?.getAttribute('aria-label')).toBe('1 source');

    await rerender({ sourcesByMessageId: undefined });
    await tick();
    expect(container.querySelector('.cinder-citation')).toBeNull();
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
    expect(document.activeElement === control).toBe(true);

    await rerender({ sourcesByMessageId: new Map() });

    await waitFor(() =>
      expect(document.activeElement === messageArticle(container, 'assistant-a')).toBe(true),
    );
    expect(control.isConnected).toBe(false);
  });

  test('removing the sources while focus is in the open list moves focus to the message', async () => {
    const { container, rerender } = render(Chat, {
      id: 'sources-list-remove',
      conversation: sourcedConversation(),
      sourcesByMessageId: new Map([['assistant-a', sourcesForA]]),
    });
    await tick();
    await fireEvent.click(sourcesControl(container, 'assistant-a')!);
    await tick();
    const link = sourceRows(container, 'assistant-a')[0]!.querySelector<HTMLAnchorElement>('a')!;
    link.focus();
    expect(document.activeElement === link).toBe(true);

    await rerender({ sourcesByMessageId: new Map([['assistant-b', sourcesForA]]) });

    await waitFor(() =>
      expect(document.activeElement === messageArticle(container, 'assistant-a')).toBe(true),
    );
    expect(sourcesControl(container, 'assistant-a')).toBeNull();
  });

  test('withdrawing the row that has focus moves focus to the next row that is a link, and says so once', async () => {
    const { container, rerender } = render(Chat, {
      id: 'sources-withdraw-next',
      conversation: sourcedConversation(),
      sourcesByMessageId: new Map([['assistant-a', sourcesForA]]),
    });
    await tick();
    await fireEvent.click(sourcesControl(container, 'assistant-a')!);
    await tick();
    const removed = sourceRows(container, 'assistant-a')[0]!.querySelector<HTMLAnchorElement>('a')!;
    removed.focus();

    await rerender({ sourcesByMessageId: new Map([['assistant-a', sourcesForA.slice(1)]]) });

    // "Board minutes" has no link, so focus goes on to the next row that has one.
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('href')).toBe('https://example.com/audit'),
    );
    expect(removed.isConnected).toBe(false);
    expect(
      Array.from(container.querySelectorAll('[aria-live="polite"], [role="status"]')).filter(
        (region) => region.textContent?.trim() === 'A source was withdrawn.',
      ),
    ).toHaveLength(1);
    expect(container.querySelector('[role="log"]')?.textContent).not.toContain(
      'A source was withdrawn.',
    );
  });

  test('withdrawing the last row that has focus moves focus to a message action', async () => {
    const sources: readonly CitationSource[] = [
      { label: 'One', url: 'https://example.com/one' },
      { label: 'Two', url: 'https://example.com/two' },
    ];
    const { container, rerender } = render(Chat, {
      id: 'sources-withdraw-last',
      conversation: sourcedConversation(),
      sourcesByMessageId: new Map([['assistant-a', sources]]),
    });
    await tick();
    await fireEvent.click(sourcesControl(container, 'assistant-a')!);
    await tick();
    const last = sourceRows(container, 'assistant-a')[1]!.querySelector<HTMLAnchorElement>('a')!;
    last.focus();

    await rerender({ sourcesByMessageId: new Map([['assistant-a', sources.slice(0, 1)]]) });

    await waitFor(() =>
      expect(document.activeElement?.matches('.chat-message-action-button')).toBe(true),
    );
    expect(last.isConnected).toBe(false);
  });

  test('withdrawing a row that does not have focus leaves focus where it is', async () => {
    const { container, rerender } = render(Chat, {
      id: 'sources-withdraw-elsewhere',
      conversation: sourcedConversation(),
      sourcesByMessageId: new Map([['assistant-a', sourcesForA]]),
    });
    await tick();
    await fireEvent.click(sourcesControl(container, 'assistant-a')!);
    await tick();
    const kept = sourceRows(container, 'assistant-a')[2]!.querySelector<HTMLAnchorElement>('a')!;
    kept.focus();

    await rerender({
      sourcesByMessageId: new Map([['assistant-a', sourcesForA.filter((_, index) => index !== 0)]]),
    });
    await tick();

    expect(document.activeElement === kept).toBe(true);
  });

  test('withdrawing a source while focus is on the open control leaves focus on the control', async () => {
    const { container, rerender } = render(Chat, {
      id: 'sources-withdraw-control',
      conversation: sourcedConversation(),
      sourcesByMessageId: new Map([['assistant-a', sourcesForA]]),
    });
    await tick();
    const control = sourcesControl(container, 'assistant-a')!;
    await fireEvent.click(control);
    control.focus();

    await rerender({ sourcesByMessageId: new Map([['assistant-a', sourcesForA.slice(1)]]) });
    await tick();

    expect(document.activeElement === control).toBe(true);
    expect(control.textContent?.trim()).toBe('3 sources');
    expect(sourceRows(container, 'assistant-a')).toHaveLength(3);
  });

  test('on a phone, withdrawing a source while its sheet is open closes the sheet and focuses a message action', async () => {
    await onPhone(async () => {
      const { container, rerender } = render(Chat, {
        id: 'sources-withdraw-sheet',
        conversation: sourcedConversation(),
        variant: 'transcript',
        sourcesByMessageId: new Map([['assistant-a', sourcesForA]]),
      });
      await tick();
      const control = sourcesControl(container, 'assistant-a')!;
      await fireEvent.click(control);
      await waitFor(() => expect(document.querySelector('.cinder-popover__sheet')).not.toBeNull());
      const row = document.querySelector<HTMLElement>('.cinder-popover__sheet a');
      row?.focus();

      await rerender({ sourcesByMessageId: new Map([['assistant-a', sourcesForA.slice(1)]]) });

      await waitFor(() =>
        expect(document.activeElement?.matches('.chat-message-action-button')).toBe(true),
      );
    });
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
