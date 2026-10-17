/// <reference lib="dom" />
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { tick } from 'svelte';

import { setupHappyDom } from '@lostgradient/testing';
import type { ConversationSummary } from './conversation-summary.ts';

setupHappyDom();

const { render, fireEvent, cleanup } = await import('@testing-library/svelte');
const { default: ChatConversationList } = await import('./chat-conversation-list.svelte');

type ObserverRecord = { options: IntersectionObserverInit | undefined; targets: Element[] };

class RecordingIntersectionObserver {
  static records: ObserverRecord[] = [];
  readonly record: ObserverRecord;

  constructor(_callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.record = { options, targets: [] };
    RecordingIntersectionObserver.records.push(this.record);
  }

  observe(target: Element): void {
    this.record.targets.push(target);
  }
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

const originalIntersectionObserver = globalThis.IntersectionObserver;

beforeEach(() => {
  RecordingIntersectionObserver.records = [];
  globalThis.IntersectionObserver =
    RecordingIntersectionObserver as unknown as typeof IntersectionObserver;
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

afterAll(() => {
  globalThis.IntersectionObserver = originalIntersectionObserver;
});

function summary(
  overrides: Partial<ConversationSummary> & Pick<ConversationSummary, 'id'>,
): ConversationSummary {
  const { id, ...rest } = overrides;
  return {
    id,
    title: rest.title ?? id,
    status: 'active',
    messageCount: 1,
    unreadCount: 0,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    participantNames: [],
    ...rest,
  };
}

describe('ChatConversationList agent label and activity', () => {
  test('renders the agent as a label on its row', () => {
    const { container } = render(ChatConversationList, {
      props: {
        onSelectConversation: () => {},
        conversations: [
          summary({ id: 'with-agent', agent: { id: 'agent-1', name: 'Atlas' } }),
          summary({ id: 'without-agent', updatedAt: '2026-05-01T00:00:00.000Z' }),
        ],
      },
    });

    const rows = [...container.querySelectorAll<HTMLElement>('li > button')];
    const label = rows[0]!.querySelector('[data-cinder-conversation-agent]');
    expect(label?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Agent: Atlas');
    expect(rows[1]!.querySelector('[data-cinder-conversation-agent]')).toBeNull();
  });

  test.each([
    ['running', 'Running'],
    ['awaiting-input', 'Awaiting input'],
  ] as const)('renders a named status indicator for %s', (activity, name) => {
    const { container } = render(ChatConversationList, {
      props: {
        onSelectConversation: () => {},
        conversations: [summary({ id: 'busy', activity })],
      },
    });

    const indicator = container.querySelector<HTMLElement>(
      `[data-cinder-conversation-activity="${activity}"]`,
    );
    expect(indicator).not.toBeNull();
    expect(indicator?.getAttribute('role')).toBe('img');
    expect(indicator?.getAttribute('aria-label')).toBe(name);
    expect(indicator?.textContent).toContain(name);
  });

  test('renders no indicator for idle', () => {
    const { container } = render(ChatConversationList, {
      props: {
        onSelectConversation: () => {},
        conversations: [summary({ id: 'quiet', activity: 'idle' })],
      },
    });

    expect(container.querySelector('[data-cinder-conversation-activity]')).toBeNull();
    expect(container.querySelector('.cinder-chat-conversation-list__meta')).toBeNull();
  });

  test('renders rows without agent or activity exactly as before', () => {
    const plain = [
      summary({ id: 'one', title: 'One', lastMessageText: 'Preview', unreadCount: 3 }),
    ];
    const first = render(ChatConversationList, { props: { conversations: plain } });
    const baseline = first.container.innerHTML;
    cleanup();
    const second = render(ChatConversationList, {
      props: { conversations: [{ ...plain[0]!, activity: 'idle' }] },
    });

    expect(second.container.innerHTML).toBe(baseline);
    expect(baseline).not.toContain('cinder-chat-conversation-list__meta');
    expect(baseline).not.toContain('data-cinder-conversation-list-scrolls');
  });

  test('shows agent and activity on non-interactive rows too', () => {
    const { container } = render(ChatConversationList, {
      props: {
        conversations: [
          summary({ id: 'static', agent: { id: 'a', name: 'Atlas' }, activity: 'running' }),
        ],
      },
    });

    const item = container.querySelector<HTMLElement>('[data-cinder-conversation-static]')!;
    expect(item.querySelector('[data-cinder-conversation-agent]')).not.toBeNull();
    expect(item.querySelector('[data-cinder-conversation-activity="running"]')).not.toBeNull();
  });
});

describe('ChatConversationList load more', () => {
  const rows = [summary({ id: 'a' }), summary({ id: 'b', updatedAt: '2026-05-01T00:00:00.000Z' })];

  test('renders LoadMore after the last row with the list as its scroll root', async () => {
    const { container } = render(ChatConversationList, {
      props: { conversations: rows, hasMore: true, onLoadMore: async () => {} },
    });
    await tick();

    const nav = container.querySelector('nav')!;
    const loadMore = nav.querySelector('.cinder-load-more');
    expect(loadMore).not.toBeNull();
    expect(nav.lastElementChild).toBe(loadMore);
    expect(nav.querySelector('ul')!.compareDocumentPosition(loadMore!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(nav.hasAttribute('data-cinder-conversation-list-scrolls')).toBe(true);
    const observer = RecordingIntersectionObserver.records.find(
      (record) => record.options?.root !== undefined,
    );
    expect(observer?.options?.root).toBe(nav);
  });

  test('renders nothing without hasMore or without onLoadMore', async () => {
    const withoutHasMore = render(ChatConversationList, {
      props: { conversations: rows, onLoadMore: async () => {} },
    });
    await tick();
    expect(withoutHasMore.container.querySelector('.cinder-load-more')).toBeNull();
    cleanup();

    const withoutHandler = render(ChatConversationList, {
      props: { conversations: rows, hasMore: true },
    });
    await tick();
    expect(withoutHandler.container.querySelector('.cinder-load-more')).toBeNull();
    expect(
      withoutHandler.container
        .querySelector('nav')!
        .hasAttribute('data-cinder-conversation-list-scrolls'),
    ).toBe(false);
  });

  test('clicking the button calls onLoadMore, and forwards buttonLabel', async () => {
    let calls = 0;
    const { container } = render(ChatConversationList, {
      props: {
        conversations: rows,
        hasMore: true,
        buttonLabel: 'Show older sessions',
        onLoadMore: async () => {
          calls += 1;
        },
      },
    });
    await tick();

    const button = container.querySelector<HTMLButtonElement>('.cinder-load-more__button')!;
    expect(button.textContent?.trim()).toBe('Show older sessions');
    await fireEvent.click(button);
    expect(calls).toBe(1);
  });

  test('uses the default label when buttonLabel is omitted', async () => {
    const { container } = render(ChatConversationList, {
      props: { conversations: rows, hasMore: true, onLoadMore: async () => {} },
    });
    await tick();

    expect(container.querySelector('.cinder-load-more__button')?.textContent?.trim()).toBe(
      'Load more',
    );
  });

  test('marks the control busy and disabled while loading', async () => {
    const { container } = render(ChatConversationList, {
      props: { conversations: rows, hasMore: true, loading: true, onLoadMore: async () => {} },
    });
    await tick();

    const button = container.querySelector<HTMLButtonElement>('.cinder-load-more__button')!;
    expect(button.disabled).toBe(true);
    expect(container.querySelector('.cinder-load-more')?.getAttribute('aria-busy')).toBe('true');
  });

  test('forwards a load failure to onError', async () => {
    const errors: unknown[] = [];
    const failure = new Error('page failed');
    const { container } = render(ChatConversationList, {
      props: {
        conversations: rows,
        hasMore: true,
        onLoadMore: async () => {
          throw failure;
        },
        onError: (error: unknown) => errors.push(error),
      },
    });
    await tick();

    await fireEvent.click(container.querySelector('.cinder-load-more__button')!);
    await tick();

    expect(errors).toEqual([failure]);
  });

  test('also offers loading when the list is empty so the first page can be requested', async () => {
    const { container } = render(ChatConversationList, {
      props: { conversations: [], hasMore: true, onLoadMore: async () => {} },
    });
    await tick();

    expect(container.querySelector('.cinder-load-more__button')).not.toBeNull();
  });
});
