/**
 * Feeds the notification store from the Bureau. It reads what is waiting on the person (the same
 * reviews query the navigation's count and `/reviews` read, so a decision made in a chat or on
 * Reviews refreshes the bell at once), the caller's notifications (a failed run, a run over its
 * budget, whatever a host wrote), the most recently changed tasks, for the answers, and the chats
 * they belong to. All of them follow `bureau.events` (a run, a session, a review, a notification)
 * and are asked on a timer, every {@link REVIEW_POLL_MILLISECONDS}, only while it is not live. Call it once, while the shell
 * initializes: the queries and effects belong to the calling component.
 *
 * Opening a chat reads the items about it, and that includes an answer that finishes while the
 * chat is open: it is listed, and it is read on arrival, so it is not new when the person leaves.
 */
import { createQuery, useQueryClient } from '@tanstack/svelte-query';

import {
  listBureauNotifications,
  markBureauNotificationsRead,
} from '../lib/bureau-notifications.ts';
import { queryKeys } from '../lib/query.ts';
import { recentTasksQuery } from '../lib/recent-tasks.ts';
import { router } from '../lib/router.svelte.ts';
import { REVIEW_POLL_MILLISECONDS, bureauReviewsQuery } from '../routes/reviews/reviews-data.ts';
import { useBureauEventsLive } from './live-polling.svelte.ts';
import { buildNotificationEntries } from './notification-items.ts';
import { loadChats, loadScheduleNames } from './notification-sources.ts';
import type { NotificationStore } from './notifications.svelte.ts';

/** The chat the person has open, or `undefined` on any other page (and on a chat not yet started). */
function openChatSessionId(): string | undefined {
  const { route, params } = router.current;
  return route?.pattern === '/chats/:chat' ? params['chat'] : undefined;
}

export function connectNotificationFeed(store: NotificationStore): void {
  const reviews = bureauReviewsQuery();
  const bureauLive = useBureauEventsLive();
  // Read in the option getters, so a query goes back to its timer when the feed is lost.
  const tasks = createQuery(() => {
    const polling = !bureauLive();
    return {
      ...recentTasksQuery(),
      // The tasks follow `run.*` and `review.*`. A catalog run is announced by `run.settled` alone
      // (its registration and actions are not published, and no `run.removed` follows it, COR-1730),
      // so the timer is also what shows one that is still running whenever the feed is not live.
      // poll-reason: fallback
      refetchInterval: polling ? REVIEW_POLL_MILLISECONDS : false,
      retry: false,
    };
  });
  // The chats follow `session.created`, `session.saved` and `session.deleted`.
  const chats = createQuery(() => {
    const polling = !bureauLive();
    return {
      queryKey: queryKeys.contexts.titles(),
      queryFn: ({ signal }: { signal: AbortSignal }) => loadChats({ signal }),
      // poll-reason: fallback
      refetchInterval: polling ? REVIEW_POLL_MILLISECONDS : false,
      retry: false,
    };
  });
  // The Bureau writes a notification after the event that caused it, so `notification.created` is
  // what tells the bell it exists; a host's own notification has no other event.
  const notifications = createQuery(() => {
    const polling = !bureauLive();
    return {
      queryKey: queryKeys.bureauNotifications.list(),
      queryFn: ({ signal }: { signal: AbortSignal }) => listBureauNotifications({ signal }),
      // poll-reason: fallback
      refetchInterval: polling ? REVIEW_POLL_MILLISECONDS : false,
      retry: false,
    };
  });
  const scheduleIds = $derived(
    [
      ...new Set(
        (notifications.data ?? []).flatMap((notification) =>
          notification.subject?.scheduleId === undefined ? [] : [notification.subject.scheduleId],
        ),
      ),
    ].toSorted(),
  );
  const scheduleNames = createQuery(() => {
    // The notifications are read once, so the lookup answers for exactly the schedules its key names.
    const wanted = scheduleIds;
    return {
      queryKey: ['bureau-schedules', 'notification-names', wanted] as const,
      queryFn: ({ signal }: { signal: AbortSignal }) => loadScheduleNames(wanted, { signal }),
      enabled: wanted.length > 0,
      // A schedule's name does not change under a failure already recorded.
      staleTime: Infinity,
      retry: false,
    };
  });

  const queryClient = useQueryClient();
  // Reading an item in the bell reads it in the Bureau, so another browser agrees. The local read
  // state already holds the item as read, so a call that fails changes nothing here.
  store.setRemote({
    markRead: (notificationIds) => {
      markBureauNotificationsRead(notificationIds)
        .then(() => queryClient.invalidateQueries({ queryKey: ['bureau-notifications'] }))
        .catch(() => undefined);
    },
  });

  $effect(() => {
    store.setActivity(
      buildNotificationEntries({
        reviews: reviews.data ?? [],
        tasks: tasks.data?.tasks ?? [],
        notifications: notifications.data ?? [],
        chats: chats.data ?? new Map(),
        scheduleNames: scheduleNames.data ?? new Map(),
        nowMs: Date.now(),
      }),
    );
  });

  $effect(() => {
    const sessionId = openChatSessionId();
    // Read after the items above are set, so what arrives while the chat is open is read on arrival.
    if (sessionId !== undefined) store.markSessionRead(sessionId);
  });
}
