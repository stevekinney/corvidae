/**
 * Feeds the notification store from the Bureau. It reads what is waiting on the person (the same
 * reviews query the navigation's count and `/reviews` read, so a decision made in a chat or on
 * Reviews refreshes the bell at once), the most recently changed tasks, and the chats they belong
 * to, each asked again every {@link REVIEW_POLL_MILLISECONDS}. Call it once, while the shell
 * initializes: the queries and effects belong to the calling component.
 *
 * Opening a chat reads the items about it, and that includes an answer that finishes while the
 * chat is open: it is listed, and it is read on arrival, so it is not new when the person leaves.
 */
import { createQuery } from '@tanstack/svelte-query';

import { recentTasksQuery } from '../lib/recent-tasks.ts';
import { router } from '../lib/router.svelte.ts';
import { REVIEW_POLL_MILLISECONDS, bureauReviewsQuery } from '../routes/reviews/reviews-data.ts';
import { buildNotificationEntries } from './notification-items.ts';
import { isScheduledFailure, loadChats, loadScheduleNames } from './notification-sources.ts';
import type { NotificationStore } from './notifications.svelte.ts';

/** The chat the person has open, or `undefined` on any other page (and on a chat not yet started). */
function openChatSessionId(): string | undefined {
  const { route, params } = router.current;
  return route?.pattern === '/chat/:sessionId' ? params['sessionId'] : undefined;
}

export function connectNotificationFeed(store: NotificationStore): void {
  const reviews = bureauReviewsQuery();
  const tasks = createQuery(() => ({
    ...recentTasksQuery(),
    refetchInterval: REVIEW_POLL_MILLISECONDS,
    retry: false,
  }));
  const chats = createQuery(() => ({
    queryKey: ['contexts', 'titles'] as const,
    queryFn: ({ signal }) => loadChats({ signal }),
    refetchInterval: REVIEW_POLL_MILLISECONDS,
    retry: false,
  }));
  const failedScheduledTasks = $derived((tasks.data?.tasks ?? []).filter(isScheduledFailure));
  const scheduleNames = createQuery(() => {
    // The tasks are read once, so the lookup answers for exactly the tasks its key names.
    const scheduled = failedScheduledTasks;
    return {
      queryKey: ['bureau-audit', 'schedule-names', scheduled.map((task) => task.id)] as const,
      queryFn: ({ signal }: { signal: AbortSignal }) => loadScheduleNames(scheduled, { signal }),
      enabled: scheduled.length > 0,
      // A fire's schedule does not change once recorded.
      staleTime: Infinity,
      retry: false,
    };
  });

  $effect(() => {
    store.setActivity(
      buildNotificationEntries({
        reviews: reviews.data ?? [],
        tasks: tasks.data?.tasks ?? [],
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
