<script lang="ts">
  /**
   * Home's Recent chats card: the chats you were last in, newest first, in the pattern every list of
   * chats uses. A status dot and its word lead each row in the one fixed column, then the chat's
   * title in bold with the latest message under it, and the time it last changed at the right
   * ("10:42 AM" today, "Yesterday, 4:12 PM" before). A row opens the chat.
   *
   * It reads what the chat list reads: the recent runs, so a chat whose latest run failed says
   * Failed here too, and the reviews waiting, so a chat that waits on you says what it asks. When
   * either read fails the rows still show, without it. Before the first message is sent the card is
   * a compact empty state with an accent chat disc, and its link to All chats waits for a chat.
   */
  import { DataList, EmptyState, StackedListItem, StatusDot } from '@lostgradient/cinder';
  import { MessageSquare } from '@lucide/svelte';
  import { createQuery } from '@tanstack/svelte-query';

  import { HOME_COPY } from '../../app/copy.ts';
  import { chatSessionPath } from '../../lib/identifier-paths.ts';
  import { chatsWithFailedRun, recentTasksQuery } from '../../lib/recent-tasks.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { pendingQuestions } from '../chat/session-groups.ts';
  import { bureauReviewsQuery } from '../reviews/reviews-data.ts';
  import { useMinuteClock } from './home-clock.svelte.ts';
  import HomeCard from './home-card.svelte';
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

  /**
   * A row's link opens its chat without leaving the application. Cinder's row draws the link
   * itself, so the click is read where it lands, and a modified click is left to the browser.
   */
  function follow(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    const href = link?.getAttribute('href');
    if (href === null || href === undefined) return;
    event.preventDefault();
    router.navigate(href);
  }
</script>

<HomeCard
  title={copy.title}
  link={chats.data !== undefined && rows.length === 0
    ? undefined
    : { label: copy.link, href: '/chats' }}
>
  {#if chats.data !== undefined && rows.length === 0}
    <EmptyState
      kind="first-use"
      size="compact"
      headingLevel={3}
      title={copy.empty.title}
      description={copy.empty.description}
    >
      {#snippet icon()}<MessageSquare aria-hidden="true" />{/snippet}
    </EmptyState>
  {:else if rows.length > 0}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div onclick={follow}>
      <DataList items={rows} key={(row) => row.id} aria-label={copy.listLabel} statusColumn>
        {#snippet children(row)}
          <StackedListItem
            data-chat={row.id}
            href={router.href(chatSessionPath(row.id))}
            tooltip={row.title}
            metaTooltip={row.latest}
          >
            {#snippet status()}<StatusDot word={row.status} />{/snippet}
            {#snippet title()}{row.title}{/snippet}
            {#snippet time()}{row.time}{/snippet}
            {#snippet meta()}{row.latest}{/snippet}
          </StackedListItem>
        {/snippet}
      </DataList>
    </div>
  {/if}
</HomeCard>
