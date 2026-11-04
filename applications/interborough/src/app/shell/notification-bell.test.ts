/**
 * Component tests for `<NotificationBell>` (design rows 02w and 02x): the bell carries a dot while
 * anything is unread, the popover is titled with the unread count, each row is a sentence with a
 * second line and how long ago, and opening a row reads it.
 */
import { fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { router } from '../../lib/router.svelte.ts';
import type { NotificationEntry } from '../notification-items.ts';
import { memoryStore } from '../notification-store.test-support.ts';
import NotificationBell from './notification-bell.svelte';

/** Gives happy-dom's `about:blank` window a real origin, so `pushState` takes effect, at `path`. */
function landAt(path: string): void {
  if (!(window instanceof Window)) throw new Error('expected a happy-dom test window');
  window.happyDOM.setURL('http://localhost/');
  router.navigate(path, { replace: true });
}

function entry(overrides: Partial<NotificationEntry> = {}): NotificationEntry {
  return {
    id: 'review:one',
    kind: 'approval',
    tier: 'warning',
    icon: 'shield-question-mark',
    title: 'Refund order 1234 for $42.00?',
    detail: 'Waiting for your approval · Tool runner',
    sessionId: 'session-refund',
    href: '/chats/session-refund',
    emittedAtMs: Date.now() - 120_000,
    ...overrides,
  };
}

/** A rule of the host's that is firing: listed read, and never counted. */
const STANDING = entry({
  id: 'alert:storage.size:1',
  kind: 'alert',
  tier: 'info',
  standing: true,
  icon: 'triangle-alert',
  title: 'Storage passed its warning level',
  detail: '1.6 GB used',
  href: '/health',
});

describe('NotificationBell', () => {
  test('shows no dot when nothing is unread', () => {
    const store = memoryStore();
    const { getByRole, container } = render(NotificationBell, { props: { store } });

    expect(getByRole('button', { name: 'Notifications' })).not.toBeNull();
    expect(container.querySelector('.weft-notification-bell__dot')).toBeNull();
  });

  test('carries a dot and no number while anything needing the person is unread, and a standing item does not count', async () => {
    const store = memoryStore();
    store.setActivity([
      entry({ id: 'review:a' }),
      entry({ id: 'review:b', kind: 'question', title: 'request-human-input asked a question' }),
      STANDING,
    ]);

    const { getByRole, container } = render(NotificationBell, { props: { store } });

    const dot = container.querySelector('.weft-notification-bell__dot');
    expect(dot?.getAttribute('aria-hidden')).toBe('true');
    expect(dot?.textContent).toBe('');
    expect(getByRole('button', { name: 'Notifications, 2 unread' })).not.toBeNull();
  });

  test('the button says how many are unread, for one item too', () => {
    const store = memoryStore();
    store.setActivity([entry()]);

    const { getByRole } = render(NotificationBell, { props: { store } });

    expect(getByRole('button', { name: 'Notifications, 1 unread' })).not.toBeNull();
  });

  test('each row is the sentence, its second line, and how long ago, in one flat list', async () => {
    const store = memoryStore();
    store.setActivity([entry(), STANDING]);
    const { getByRole } = render(NotificationBell, { props: { store } });

    await fireEvent.click(getByRole('button', { name: 'Notifications, 1 unread' }));

    const rows = Array.from(document.body.querySelectorAll('.weft-notification-panel__item'));
    expect(rows.map((row) => row.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Refund order 1234 for $42.00? Waiting for your approval · Tool runner 2 min',
      'Storage passed its warning level 1.6 GB used 2 min',
    ]);
    expect(document.body.querySelector('.weft-notification-panel__group-label')).toBeNull();
  });

  test('is titled with the unread count, and has no alerts link', async () => {
    const store = memoryStore();
    store.setActivity([entry()]);
    const { getByRole } = render(NotificationBell, { props: { store } });

    await fireEvent.click(getByRole('button', { name: 'Notifications, 1 unread' }));

    expect(document.body.textContent).not.toContain('Open alerts view');
    const title = document.body.querySelector('.weft-notification-panel__title');
    expect(title?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Notifications · 1 unread');
  });

  test('says nothing needs the person with the done empty state when the list is empty', async () => {
    const store = memoryStore();
    const { getByRole, getByText } = render(NotificationBell, { props: { store } });

    await fireEvent.click(getByRole('button', { name: 'Notifications' }));

    expect(getByText('Nothing needs you right now')).not.toBeNull();
    expect(document.body.querySelector('[data-cinder-kind="done"]')).not.toBeNull();
    expect(document.body.querySelector('.weft-notification-panel__empty')).toBeNull();
  });

  test('a list that could not be read says so, and never that nothing needs the person', async () => {
    const store = memoryStore();
    let reloads = 0;
    store.setRemote({ markRead: () => {}, reload: () => void (reloads += 1) });
    store.setLoadFailed(true);
    const { getByRole, getByText, queryByText } = render(NotificationBell, { props: { store } });

    await fireEvent.click(getByRole('button', { name: 'Notifications' }));

    expect(getByText('Notifications could not be loaded')).not.toBeNull();
    expect(queryByText('Nothing needs you right now')).toBeNull();
    await fireEvent.click(getByText('Try again'));
    expect(reloads).toBe(1);
  });

  test('a list that could not be read keeps showing what was last read', async () => {
    const store = memoryStore();
    store.setActivity([entry()]);
    store.setLoadFailed(true);
    const { getByRole, getByText } = render(NotificationBell, { props: { store } });

    await fireEvent.click(getByRole('button', { name: 'Notifications, 1 unread' }));

    expect(getByText('Notifications could not be loaded')).not.toBeNull();
    expect(document.body.querySelectorAll('.weft-notification-panel__item')).toHaveLength(1);
  });

  test('a mark-as-read the Bureau refused is said, and the items are unread again', async () => {
    const store = memoryStore();
    store.setActivity([entry({ notificationId: 'n-1', id: 'notification:n-1' })]);
    store.setRemote({
      markRead: async () => {
        throw new Error('did not answer');
      },
    });
    const { getByRole, getByText } = render(NotificationBell, { props: { store } });
    await fireEvent.click(getByRole('button', { name: 'Notifications, 1 unread' }));

    await fireEvent.click(getByText('Mark all read'));

    await waitFor(() => expect(getByText(/could not be marked as read/)).not.toBeNull());
    expect(store.unreadCount).toBe(1);
  });

  test('ends with where notifications are set up: their settings, and Hooks', async () => {
    landAt('/agents');
    const store = memoryStore();
    const { getByRole } = render(NotificationBell, { props: { store } });
    await fireEvent.click(getByRole('button', { name: 'Notifications' }));

    const links = document.body.querySelector<HTMLElement>('.weft-notification-panel__links');
    expect(links?.getAttribute('aria-label')).toBe('Where notifications are set up');
    expect(
      [...(links?.querySelectorAll('a') ?? [])].map((link) => link.textContent?.trim()),
    ).toEqual(['Notification settings', 'Email or webhooks: set up a hook ›']);

    await fireEvent.click(
      within(links as HTMLElement).getByText('Email or webhooks: set up a hook ›'),
    );
    expect(router.pathname).toBe('/hooks');
    await waitFor(() =>
      expect(document.body.querySelectorAll('.weft-notification-panel')).toHaveLength(0),
    );
  });

  test('Mark all read is marked as a control that changes something', async () => {
    const store = memoryStore();
    const { getByRole, getByText } = render(NotificationBell, { props: { store } });
    await fireEvent.click(getByRole('button', { name: 'Notifications' }));

    expect(getByText('Mark all read').closest('button')?.hasAttribute('data-changes')).toBe(true);
  });

  test('a schedule that missed a run is a row with its own icon', async () => {
    const store = memoryStore();
    store.setActivity([
      entry({
        id: 'schedule-missed:s-1:1',
        kind: 'missed',
        icon: 'calendar-x',
        title: 'Daily summary missed its 3:00 AM run',
        detail: '4 missed since Oct 30 · Assistant',
        href: '/schedules/s-1',
      }),
    ]);
    const { getByRole } = render(NotificationBell, { props: { store } });

    await fireEvent.click(getByRole('button', { name: 'Notifications, 1 unread' }));

    const row = document.body.querySelector('[data-kind="missed"]');
    expect(row?.textContent?.replace(/\s+/g, ' ')).toContain(
      'Daily summary missed its 3:00 AM run',
    );
    expect(row?.querySelector('svg')).not.toBeNull();
  });

  test('"Mark all read" clears the badge and keeps the rows', async () => {
    const store = memoryStore();
    store.setActivity([entry({ id: 'review:a' }), entry({ id: 'review:b' }), STANDING]);

    const { getByRole, getByText, container } = render(NotificationBell, { props: { store } });
    await fireEvent.click(getByRole('button', { name: 'Notifications, 2 unread' }));
    await fireEvent.click(getByText('Mark all read'));

    expect(store.unreadCount).toBe(0);
    expect(container.querySelector('.weft-notification-bell__dot')).toBeNull();
    expect(document.body.querySelectorAll('.weft-notification-panel__item')).toHaveLength(3);
  });

  test('opening a row marks it read, goes to its chat, and closes the panel', async () => {
    landAt('/agents');
    const store = memoryStore();
    store.setActivity([entry()]);

    const { getByRole, getByText, queryByText } = render(NotificationBell, { props: { store } });
    await fireEvent.click(getByRole('button', { name: 'Notifications, 1 unread' }));
    await fireEvent.click(getByText('Refund order 1234 for $42.00?'));

    expect(store.items[0]?.read).toBe(true);
    expect(router.pathname).toBe('/chats/session-refund');
    expect(queryByText('Mark all read')).toBeNull();
  });

  test('a long list scrolls inside its own wrapper, with the header outside it', async () => {
    // The panel once had `overflow: hidden` with no `max-height`, so a large list rendered as one
    // unbounded panel. Only the list scrolls.
    const store = memoryStore();
    store.setActivity(Array.from({ length: 30 }, (_, index) => entry({ id: `review:${index}` })));

    const { getByRole } = render(NotificationBell, { props: { store } });
    await fireEvent.click(getByRole('button', { name: 'Notifications, 30 unread' }));

    const list = document.body.querySelector('.weft-notification-panel__list');
    const header = document.body.querySelector('.weft-notification-panel__bar');
    expect(list?.querySelectorAll('.weft-notification-panel__item').length).toBe(30);
    expect(header?.contains(list ?? null)).toBe(false);
  });

  test('the host’s own problem is a row that links to the engine', async () => {
    landAt('/agents');
    const store = memoryStore();
    store.reportEngineStatus('closed', Date.now());
    store.reportEngineStatus('stale', Date.now());

    const { getByRole, getByText } = render(NotificationBell, { props: { store } });
    await fireEvent.click(getByRole('button', { name: 'Notifications, 1 unread' }));
    await fireEvent.click(getByText('Server status stale'));

    expect(router.pathname).toBe('/health');
    expect(store.unreadCount).toBe(0);
  });

  test('Escape closes the panel', async () => {
    const store = memoryStore();
    store.setActivity([entry()]);

    const { getByRole, getByText } = render(NotificationBell, { props: { store } });
    await fireEvent.click(getByRole('button', { name: 'Notifications, 1 unread' }));
    expect(getByText('Mark all read')).not.toBeNull();

    await fireEvent.keyDown(document.body, { key: 'Escape' });

    await waitFor(() =>
      expect(document.body.querySelectorAll('.weft-notification-panel')).toHaveLength(0),
    );
  });
  test('tints an unread row and marks it with a dot a screen reader calls Unread; a read row has neither', async () => {
    const store = memoryStore();
    store.setActivity([entry({ id: 'review:a' }), entry({ id: 'review:b' })]);
    store.markRead('review:b');
    const { getByRole } = render(NotificationBell, { props: { store } });
    await fireEvent.click(getByRole('button', { name: 'Notifications, 1 unread' }));

    const [unread, read] = Array.from(
      document.body.querySelectorAll('.weft-notification-panel__item'),
    );
    expect(unread?.getAttribute('data-read')).toBe('false');
    expect(unread?.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Unread');
    expect(read?.getAttribute('data-read')).toBe('true');
    expect(read?.querySelector('[role="img"]')).toBeNull();
  });

  test('draws a standing item, which is listed but never counts, without the tint or the dot of an unread row', async () => {
    const store = memoryStore();
    store.setActivity([entry(), STANDING]);
    const { getByRole } = render(NotificationBell, { props: { store } });
    await fireEvent.click(getByRole('button', { name: 'Notifications, 1 unread' }));

    const [waiting, standing] = Array.from(
      document.body.querySelectorAll('.weft-notification-panel__item'),
    );
    expect(waiting?.getAttribute('data-read')).toBe('false');
    expect(standing?.getAttribute('data-read')).toBe('true');
    expect(standing?.querySelector('[role="img"]')).toBeNull();
    expect(document.body.querySelectorAll('.weft-notification-panel__item-dot')).toHaveLength(1);
  });

  test('tints a question’s icon as information, and a failure and a firing rule as warnings', async () => {
    const store = memoryStore();
    store.setActivity([
      entry({ id: 'review:q', kind: 'question', icon: 'message-circle-question-mark' }),
      entry({ id: 'notification:f', kind: 'failed', icon: 'circle-x' }),
      STANDING,
    ]);
    const { getByRole } = render(NotificationBell, { props: { store } });
    await fireEvent.click(getByRole('button', { name: 'Notifications, 2 unread' }));

    const tones = Array.from(
      document.body.querySelectorAll('.weft-notification-panel__item-tile'),
    ).map((tile) => tile.getAttribute('data-tone'));
    expect(tones).toEqual(['info', 'warning', 'warning']);
  });

  test('lists a firing rule read, with a warning icon, and it never counts or marks the bell', async () => {
    const store = memoryStore();
    store.setActivity([
      entry({
        id: 'alert:storage.size:1',
        kind: 'alert',
        tier: 'info',
        standing: true,
        icon: 'triangle-alert',
        title: 'Storage passed its warning level',
        detail: '1.6 GB used',
        href: '/health',
      }),
    ]);
    const { getByRole, container } = render(NotificationBell, { props: { store } });
    expect(container.querySelector('.weft-notification-bell__dot')).toBeNull();
    await fireEvent.click(getByRole('button', { name: 'Notifications' }));

    const row = document.body.querySelector('[data-kind="alert"]');
    expect(row?.getAttribute('data-read')).toBe('true');
    expect(row?.querySelector('[role="img"]')).toBeNull();
    expect(
      row?.querySelector('.weft-notification-panel__item-tile')?.getAttribute('data-tone'),
    ).toBe('warning');
    expect(
      document.body.querySelector('.weft-notification-panel__title')?.textContent,
    ).not.toContain('unread');
  });

  test('says how long ago in the few characters a time column has', async () => {
    const store = memoryStore();
    store.setActivity([
      entry({ id: 'review:a', emittedAtMs: Date.now() - 220_000 }),
      entry({ id: 'review:b', emittedAtMs: Date.now() - 3_600_000 }),
    ]);
    const { getByRole } = render(NotificationBell, { props: { store } });
    await fireEvent.click(getByRole('button', { name: 'Notifications, 2 unread' }));

    expect(
      Array.from(document.body.querySelectorAll('.weft-notification-panel__item-time')).map(
        (time) => time.textContent?.trim(),
      ),
    ).toEqual(['4 min', '1 h']);
  });
});
