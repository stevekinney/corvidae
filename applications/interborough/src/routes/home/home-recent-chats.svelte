<script lang="ts">
  /**
   * Home's Recent chats section: the chats you were last in, newest first, as one Cinder
   * `GroupedList`. Each row is the chat's title, then a subtitle that leads with its status (a dot
   * and its word) and goes on with the latest message, and the time it last changed at the end
   * ("10:42 AM" today, "Yesterday, 4:12 PM" before). The whole row is a link that opens the chat.
   *
   * It reads what the chat list reads: the recent runs, so a chat whose latest run failed says
   * Failed here too, and the reviews waiting, so a chat that waits on you says what it asks. When
   * either read fails the rows still show, without it. Before the first message is sent the section
   * is a compact empty state with an accent chat disc, and its link to All chats waits for a chat. A
   * list that cannot be read says so in place, with a Try again and no link; while it has not
   * answered the section holds Cinder's grouped placeholder rows.
   */
  import {
    EmptyState,
    GroupedList,
    GroupedListItem,
    Skeleton,
    StatusDot,
  } from '@lostgradient/cinder';
  import { MessageSquare } from '@lucide/svelte';
  import { createQuery } from '@tanstack/svelte-query';

  import { HOME_COPY } from '../../app/copy/home.ts';
  import { followLinks } from '../../lib/follow-links.ts';
  import { chatSessionPath } from '../../lib/identifier-paths.ts';
  import { chatsWithFailedRun, recentTasksQuery } from '../../lib/recent-tasks.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { pendingQuestions } from '../chat/session-groups.ts';
  import { bureauReviewsQuery } from '../reviews/reviews-data.ts';
  import { useMinuteClock } from './home-clock.svelte.ts';
  import HomeCard from './home-card.svelte';
  import HomeCardError from './home-card-error.svelte';
  import { useRecentChats } from './home-queries.svelte.ts';
  import { recentChatRows } from './home-rows.ts';

  const copy = HOME_COPY.recent;
  const clock = useMinuteClock();
  const chats = useRecentChats();
  const tasks = createQuery(() => ({ ...recentTasksQuery(), retry: false }));
  const reviews = bureauReviewsQuery();

  const rows = $derived(
    recentChatRows(
      chats.data?.contexts ?? [],
      pendingQuestions(reviews.data ?? []),
      chatsWithFailedRun(tasks.data?.tasks ?? []),
      clock(),
    ),
  );
</script>

<HomeCard
  title={copy.title}
  link={chats.data === undefined || rows.length === 0
    ? undefined
    : { label: copy.link, href: '/chats' }}
>
  {#if chats.data === undefined && chats.isError}
    <HomeCardError
      title={HOME_COPY.states.cardFailed.recent}
      onRetry={() => void chats.refetch()}
    />
  {:else if chats.data === undefined}
    <Skeleton variant="grouped" rows={3} />
  {:else if rows.length === 0}
    <EmptyState
      kind="first-use"
      size="compact"
      headingLevel={3}
      title={copy.empty.title}
      description={copy.empty.description}
    >
      {#snippet icon()}<MessageSquare aria-hidden="true" />{/snippet}
    </EmptyState>
  {:else}
    <div {@attach followLinks}>
      <GroupedList aria-label={copy.listLabel}>
        {#each rows as row (row.id)}
          <GroupedListItem data-chat={row.id} href={router.href(chatSessionPath(row.id))}>
            {#snippet title()}{row.title}{/snippet}
            {#snippet subtitle()}<StatusDot word={row.status} />, {row.latest}{/snippet}
            {#snippet trailing()}{row.time}{/snippet}
          </GroupedListItem>
        {/each}
      </GroupedList>
    </div>
  {/if}
</HomeCard>
