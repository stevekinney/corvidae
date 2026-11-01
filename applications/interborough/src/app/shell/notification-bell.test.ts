/**
 * Component tests for `<NotificationBell>`: the badge counts what needs the person, each row is
 * one sentence and the chat it is about, and opening a row reads it.
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
    title: 'tool-runner needs your approval',
    identifiers: ['tool-runner'],
    detail: 'Refund order 1234',
    joiner: ' in ',
    sessionId: 'session-refund',
    href: '/chats/session-refund',
    emittedAtMs: Date.now() - 120_000,
    ...overrides,
  };
}

const ANSWERED = entry({
  id: 'task:echo',
  kind: 'answered',
  tier: 'info',
  icon: 'message-circle-check',
  title: 'echo answered',
  identifiers: ['echo'],
  detail: 'Hello echo, say this back',
  sessionId: 'session-echo',
  href: '/chats/session-echo',
});

describe('NotificationBell', () => {
  test('shows no badge when nothing needs the person', () => {
    const store = memoryStore();
    const { getByRole, container } = render(NotificationBell, { props: { store } });

    expect(getByRole('button', { name: 'Notifications' })).not.toBeNull();
    expect(container.querySelector('.weft-notification-bell__count')).toBeNull();
  });

  test('the badge counts what needs the person, and an answer does not count', async () => {
    const store = memoryStore();
    store.setActivity([
      entry({ id: 'review:a' }),
      entry({ id: 'review:b', kind: 'question', title: 'request-human-input asked a question' }),
      ANSWERED,
    ]);

    const { getByRole, container } = render(NotificationBell, { props: { store } });

    expect(container.querySelector('.weft-notification-bell__count')?.textContent).toBe('2');
    expect(getByRole('button', { name: 'Notifications, 2 need you' })).not.toBeNull();
  });

  test('the button says "needs" for one item', () => {
    const store = memoryStore();
    store.setActivity([entry()]);

    const { getByRole } = render(NotificationBell, { props: { store } });

    expect(getByRole('button', { name: 'Notifications, 1 needs you' })).not.toBeNull();
  });

  test('each row is the sentence, the chat it is about, and how long ago, in one flat list', async () => {
    const store = memoryStore();
    store.setActivity([entry(), ANSWERED]);
    const { getByRole } = render(NotificationBell, { props: { store } });

    await fireEvent.click(getByRole('button', { name: 'Notifications, 1 needs you' }));

    const rows = Array.from(document.body.querySelectorAll('.weft-notification-panel__item'));
    expect(rows.map((row) => row.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'tool-runner needs your approval in Refund order 1234 2m ago',
      'echo answered in Hello echo, say this back 2m ago',
    ]);
    expect(document.body.querySelector('.weft-notification-panel__group-label')).toBeNull();
  });

  test('an agent’s name in a sentence is set in monospace', async () => {
    const store = memoryStore();
    store.setActivity([entry()]);
    const { getByRole } = render(NotificationBell, { props: { store } });

    await fireEvent.click(getByRole('button', { name: 'Notifications, 1 needs you' }));

    expect(
      document.body.querySelector('.weft-notification-panel__item-title code')?.textContent,
    ).toBe('tool-runner');
  });

  test('a one-word agent name is set in monospace too', async () => {
    const store = memoryStore();
    store.setActivity([ANSWERED]);
    const { getByRole } = render(NotificationBell, { props: { store } });

    await fireEvent.click(getByRole('button', { name: 'Notifications' }));

    expect(
      document.body.querySelector('.weft-notification-panel__item-title code')?.textContent,
    ).toBe('echo');
  });

  test('has no alerts link and no unread badge in the bar', async () => {
    const store = memoryStore();
    store.setActivity([entry()]);
    const { getByRole } = render(NotificationBell, { props: { store } });

    await fireEvent.click(getByRole('button', { name: 'Notifications, 1 needs you' }));

    expect(document.body.textContent).not.toContain('Open alerts view');
    expect(document.body.textContent).not.toContain('unread');
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

    await fireEvent.click(getByRole('button', { name: 'Notifications, 1 needs you' }));

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
    await fireEvent.click(getByRole('button', { name: 'Notifications, 1 needs you' }));

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
    ).toEqual(['Notification settings', 'Hooks for email or webhooks']);

    await fireEvent.click(within(links as HTMLElement).getByText('Hooks for email or webhooks'));
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
        title: 'Nightly digest missed a run',
        identifiers: [],
        detail: 'The host was down or too slow to start it',
        joiner: ': ',
        href: '/schedules/s-1',
      }),
    ]);
    const { getByRole } = render(NotificationBell, { props: { store } });

    await fireEvent.click(getByRole('button', { name: 'Notifications, 1 needs you' }));

    const row = document.body.querySelector('[data-kind="missed"]');
    expect(row?.textContent?.replace(/\s+/g, ' ')).toContain('Nightly digest missed a run');
    expect(row?.querySelector('svg')).not.toBeNull();
  });

  test('"Mark all read" clears the badge and keeps the rows', async () => {
    const store = memoryStore();
    store.setActivity([entry({ id: 'review:a' }), entry({ id: 'review:b' }), ANSWERED]);

    const { getByRole, getByText, container } = render(NotificationBell, { props: { store } });
    await fireEvent.click(getByRole('button', { name: 'Notifications, 2 need you' }));
    await fireEvent.click(getByText('Mark all read'));

    expect(store.unreadCount).toBe(0);
    expect(container.querySelector('.weft-notification-bell__count')).toBeNull();
    expect(document.body.querySelectorAll('.weft-notification-panel__item')).toHaveLength(3);
  });

  test('opening a row marks it read, goes to its chat, and closes the panel', async () => {
    landAt('/agents');
    const store = memoryStore();
    store.setActivity([entry()]);

    const { getByRole, getByText, queryByText } = render(NotificationBell, { props: { store } });
    await fireEvent.click(getByRole('button', { name: 'Notifications, 1 needs you' }));
    await fireEvent.click(getByText('Refund order 1234'));

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
    await fireEvent.click(getByRole('button', { name: 'Notifications, 30 need you' }));

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
    await fireEvent.click(getByRole('button', { name: 'Notifications, 1 needs you' }));
    await fireEvent.click(getByText('Server status stale'));

    expect(router.pathname).toBe('/health');
    expect(store.unreadCount).toBe(0);
  });

  test('Escape closes the panel', async () => {
    const store = memoryStore();
    store.setActivity([entry()]);

    const { getByRole, getByText } = render(NotificationBell, { props: { store } });
    await fireEvent.click(getByRole('button', { name: 'Notifications, 1 needs you' }));
    expect(getByText('Mark all read')).not.toBeNull();

    await fireEvent.keyDown(document.body, { key: 'Escape' });

    await waitFor(() =>
      expect(document.body.querySelectorAll('.weft-notification-panel')).toHaveLength(0),
    );
  });
});
