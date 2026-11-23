<script lang="ts">
  /**
   * Home's Recent chats section: the chats you were last in, newest first, as one Cinder
   * `GroupedList`. Each row is the chat's title, then a subtitle that leads with its status badge and
   * goes on with the latest message, and the time it last changed at the end
   * ("10:42 AM" today, "Yesterday, 4:12 PM" before). The whole row is a link that opens the chat.
   *
   * It reads what the chat list reads: the recent runs, so a chat whose latest run failed says
   * Failed here too, and the reviews waiting, so a chat that waits on you says what it asks. When
   * either read fails the rows still show, without it. A latest message that only repeats the
   * chat's title (a chat titled by its first message) is not said twice: the row says its status
   * alone. With no chat to list the section draws nothing (owner, 2026-11-19): Recent chats appears
   * once a chat exists. A list that cannot be read says so in place, with a Try again and no link;
   * while it has not answered the section holds Cinder's grouped placeholder rows.
   */
  import {
    Badge,
    GroupedList,
    GroupedListItem,
    Skeleton,
    type BadgeVariant,
  } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { HOME_COPY } from '../../app/copy/home.ts';
  import { followLinks } from '../../lib/follow-links.ts';
  import { chatSessionPath } from '../../lib/identifier-paths.ts';
  import { chatsWithFailedRun, recentTasksQuery } from '../../lib/recent-tasks.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { listIsClear } from '../../lib/worth-showing.ts';
  import { pendingQuestions, waitingChatIds, type ChatStatusWord } from '../chat/session-groups.ts';
  import { bureauReviewsQuery } from '../reviews/reviews-data.ts';
  import { useMinuteClock } from './home-clock.svelte.ts';
  import HomeCard from './home-card.svelte';
  import HomeCardError from './home-card-error.svelte';
  import { useRecentChats } from './home-queries.svelte.ts';
  import { recentChatRows } from './home-rows.ts';

  const statusVariants: Record<ChatStatusWord, BadgeVariant> = {
    'Waiting on you': 'warning',
    Running: 'info',
    Failed: 'danger',
    Ended: 'neutral',
    Done: 'success',
  };

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
      undefined,
      // Waiting on you as the chat list and the chat itself say it (COR-2438).
      new Set(waitingChatIds(reviews.data ?? [])),
    ),
  );
</script>

{#if !(chats.data !== undefined && listIsClear(rows))}
  <HomeCard
    title={copy.title}
    class="ib-home-column-card"
    link={chats.data === undefined ? undefined : { label: copy.link, href: '/chats' }}
  >
    {#if chats.data === undefined && chats.isError}
      <HomeCardError
        title={HOME_COPY.states.cardFailed.recent}
        error={chats.error}
        onRetry={() => void chats.refetch()}
      />
    {:else if chats.data === undefined}
      <Skeleton variant="grouped" rows={3} />
    {:else}
      <div class="ib-home-column-fill" {@attach followLinks}>
        <GroupedList
          class="ib-home-column-list ib-home-column-fill"
          data-home-column-list
          aria-label={copy.listLabel}
        >
          {#each rows as row (row.id)}
            <GroupedListItem data-chat={row.id} href={router.href(chatSessionPath(row.id))}>
              {#snippet title()}{row.title}{/snippet}
              {#snippet subtitle()}<Badge variant={statusVariants[row.status]} size="xs"
                  >{row.status}</Badge
                >{#if row.latest !== undefined}, {row.latest}{/if}{/snippet}
              {#snippet trailing()}{row.time}{/snippet}
            </GroupedListItem>
          {/each}
        </GroupedList>
      </div>
    {/if}
  </HomeCard>
{/if}
