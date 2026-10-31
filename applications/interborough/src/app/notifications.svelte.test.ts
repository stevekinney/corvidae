/**
 * `NotificationStore`: the read state kept apart from the derived items, the badge that counts only
 * what needs the person, and the host's own problem.
 */
import { describe, expect, test } from 'bun:test';

import type { NotificationEntry } from './notification-items.ts';
import { READ_ID_LIMIT } from './notification-read-state.ts';
import { memoryStorage } from './notification-store.test-support.ts';
import { ENGINE_STATUS_ITEM_ID, NotificationStore } from './notifications.svelte.ts';

function entry(overrides: Partial<NotificationEntry> = {}): NotificationEntry {
  return {
    id: 'review:one',
    kind: 'approval',
    tier: 'warning',
    icon: 'shield-question-mark',
    title: 'tool-runner needs your approval',
    identifiers: ['tool-runner'],
    detail: 'Refund order 1234',
    joiner: ' in ',
    sessionId: 'session-refund',
    href: '/chats/session-refund',
    emittedAtMs: 1_000,
    ...overrides,
  };
}

function storeWith(...entries: NotificationEntry[]): NotificationStore {
  const store = new NotificationStore({ storage: memoryStorage() });
  store.setActivity(entries);
  return store;
}

describe('NotificationStore and the Bureau’s notifications', () => {
  const stored = (id: string, overrides: Partial<NotificationEntry> = {}) =>
    entry({ id: `notification:${id}`, notificationId: id, kind: 'failed', ...overrides });

  function connected(...entries: NotificationEntry[]) {
    const told: string[][] = [];
    const store = storeWith(...entries);
    store.setRemote({ markRead: (ids) => told.push([...ids]) });
    return { store, told };
  }

  test('reading an item that is a notification tells the Bureau, once, and only for what was unread', () => {
    const { store, told } = connected(
      stored('a'),
      stored('b', { serverRead: true }),
      entry({ id: 'review:c' }),
    );

    store.markRead('notification:a');
    store.markRead('notification:a');
    store.markRead('notification:b');
    store.markRead('review:c');

    expect(told).toEqual([['a']]);
  });

  test('reading everything, or a chat, tells the Bureau which notifications it covered', () => {
    const { store, told } = connected(
      stored('a', { sessionId: 'one' }),
      stored('b', { sessionId: 'two' }),
      entry({ id: 'review:c', sessionId: 'two' }),
    );

    store.markSessionRead('two');
    store.markAllRead();

    expect(told).toEqual([['b'], ['a']]);
  });

  test('an item the Bureau holds as read is read, and does not count', () => {
    const store = storeWith(stored('a', { serverRead: true }), stored('b'));

    expect(store.items.map((item) => item.read)).toEqual([true, false]);
    expect(store.unreadCount).toBe(1);
  });
});

describe('NotificationStore', () => {
  test('a new store has no items and no unread count', () => {
    const store = new NotificationStore({ storage: memoryStorage() });

    expect(store.items).toEqual([]);
    expect(store.unreadCount).toBe(0);
  });

  test('the badge counts approvals, questions and failures, and never an answer', () => {
    const store = storeWith(
      entry({ id: 'review:a' }),
      entry({ id: 'review:b', kind: 'question' }),
      entry({ id: 'task:c', kind: 'failed' }),
      entry({ id: 'task:d', kind: 'answered', tier: 'info' }),
    );

    expect(store.items).toHaveLength(4);
    expect(store.unreadCount).toBe(3);
  });

  test('reading an item takes it off the count and keeps it listed', () => {
    const store = storeWith(entry({ id: 'review:a' }), entry({ id: 'review:b' }));

    store.markRead('review:a');

    expect(store.unreadCount).toBe(1);
    expect(store.items.map((item) => [item.id, item.read])).toEqual([
      ['review:a', true],
      ['review:b', false],
    ]);
  });

  test('an item stays read when the items are derived again', () => {
    const store = storeWith(entry({ id: 'review:a' }));
    store.markRead('review:a');

    store.setActivity([entry({ id: 'review:a', emittedAtMs: 2_000 })]);

    expect(store.items[0]?.read).toBe(true);
    expect(store.unreadCount).toBe(0);
  });

  test('an item the Bureau no longer reports leaves the list and the count', () => {
    const store = storeWith(entry({ id: 'review:a' }), entry({ id: 'review:b' }));

    store.setActivity([entry({ id: 'review:b' })]);

    expect(store.items.map((item) => item.id)).toEqual(['review:b']);
    expect(store.unreadCount).toBe(1);
  });

  test('"mark all read" reads every item', () => {
    const store = storeWith(entry({ id: 'review:a' }), entry({ id: 'task:b', kind: 'failed' }));

    store.markAllRead();

    expect(store.unreadCount).toBe(0);
    expect(store.items.every((item) => item.read)).toBe(true);
  });

  test('"mark all read" with more items than the buffer holds keeps the newest read, not the oldest', () => {
    const count = READ_ID_LIMIT + 1;
    // Listed newest first, the way the bell lists them.
    const entries = Array.from({ length: count }, (_, index) =>
      entry({ id: `review:${count - index}`, emittedAtMs: (count - index) * 1_000 }),
    );
    const store = storeWith(...entries);

    store.markAllRead();

    const unread = store.items.filter((item) => !item.read).map((item) => item.id);
    expect(unread).toEqual(['review:1']);
    expect(store.unreadCount).toBe(1);
    expect(store.items.find((item) => item.id === `review:${count}`)?.read).toBe(true);
  });

  test('opening a chat reads the items about it and no others', () => {
    const store = storeWith(
      entry({ id: 'review:a', sessionId: 'session-refund' }),
      entry({ id: 'task:b', kind: 'answered', tier: 'info', sessionId: 'session-refund' }),
      entry({ id: 'review:c', sessionId: 'session-release' }),
    );

    store.markSessionRead('session-refund');

    expect(store.items.map((item) => [item.id, item.read])).toEqual([
      ['review:a', true],
      ['task:b', true],
      ['review:c', false],
    ]);
    expect(store.unreadCount).toBe(1);
  });

  test('read ids are kept for the next page load', () => {
    const storage = memoryStorage();
    const first = new NotificationStore({ storage });
    first.setActivity([entry({ id: 'review:a' })]);
    first.markRead('review:a');

    const second = new NotificationStore({ storage });
    second.setActivity([entry({ id: 'review:a' })]);

    expect(second.items[0]?.read).toBe(true);
  });

  test('a storage that refuses to write leaves the read state in memory', () => {
    const store = new NotificationStore({
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('QuotaExceededError');
        },
      },
    });
    store.setActivity([entry({ id: 'review:a' })]);

    store.markRead('review:a');

    expect(store.items[0]?.read).toBe(true);
  });

  describe('the host’s own problem', () => {
    test('an unreachable engine is one critical item, ahead of the rest', () => {
      const store = storeWith(entry({ id: 'review:a' }));

      store.reportEngineStatus('closed', 5_000);

      expect(store.items.map((item) => item.id)).toEqual([ENGINE_STATUS_ITEM_ID, 'review:a']);
      expect(store.items[0]).toMatchObject({
        kind: 'engine',
        tier: 'critical',
        title: 'Engine unreachable',
        href: '/health',
        emittedAtMs: 5_000,
      });
      expect(store.unreadCount).toBe(2);
      expect(store.criticalUnread).toHaveLength(1);
    });

    test('a connection that flaps between states replaces the item and does not stack another', () => {
      const store = storeWith();

      store.reportEngineStatus('closed', 1);
      store.reportEngineStatus('stale', 2);
      store.reportEngineStatus('closed', 3);

      expect(store.items).toHaveLength(1);
      expect(store.items[0]?.emittedAtMs).toBe(3);
    });

    test('the same state again leaves the item, and whether it was read, as it was', () => {
      const store = storeWith();
      store.reportEngineStatus('closed', 1);
      store.markRead(ENGINE_STATUS_ITEM_ID);

      store.reportEngineStatus('closed', 2);

      expect(store.items[0]).toMatchObject({ emittedAtMs: 1, read: true });
    });

    test('a recovery removes the item, and the next problem is unread again', () => {
      const store = storeWith();
      store.reportEngineStatus('closed', 1);
      store.markRead(ENGINE_STATUS_ITEM_ID);

      store.reportEngineStatus('live', 2);
      expect(store.items).toEqual([]);

      store.reportEngineStatus('closed', 3);
      expect(store.items[0]?.read).toBe(false);
    });

    test('a healthy engine, connecting, reconnecting or polling is not a problem', () => {
      const store = storeWith();

      for (const status of ['connecting', 'live', 'reconnecting', 'polling'] as const) {
        store.reportEngineStatus(status, 1);
        expect(store.items).toEqual([]);
      }
    });
  });

  test('dismissCritical reads a critical item and leaves any other alone', () => {
    const store = storeWith(entry({ id: 'review:a' }));
    store.reportEngineStatus('closed', 1);

    store.dismissCritical('review:a');
    expect(store.items.find((item) => item.id === 'review:a')?.read).toBe(false);

    store.dismissCritical(ENGINE_STATUS_ITEM_ID);
    expect(store.criticalUnread).toEqual([]);
    expect(store.items.find((item) => item.id === ENGINE_STATUS_ITEM_ID)?.read).toBe(true);
  });
});
