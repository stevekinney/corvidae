<script lang="ts">
  /**
   * Home's Recent chats card: the chats you were last in, newest first, in the pattern every list of
   * chats uses. A status dot and its word lead each row in the one fixed column, then the chat's
   * title in bold with the latest message under it, and the time it last changed at the right
   * ("10:42 AM" today, "Yesterday, 4:12 PM" before). A row opens the chat.
   *
   * It reads the same recent runs the chat list reads, so a chat whose latest run failed says
   * Failed here too; when that read fails the rows still show, without it.
   */
  import { DataList, StackedListItem, StatusDot } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { CHAT_COPY, HOME_COPY } from '../../app/copy.ts';
  import { listContexts } from '../../lib/bureau-client.ts';
  import { chatSessionPath } from '../../lib/identifier-paths.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { chatsWithFailedRun, recentTasksQuery } from '../../lib/recent-tasks.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { useMinuteClock } from './home-clock.svelte.ts';
  import HomeCard from './home-card.svelte';
  import { RECENT_CHAT_LIMIT, recentChatRows } from './home-rows.ts';

  const copy = HOME_COPY.recent;
  const clock = useMinuteClock();
  const chats = createQuery(() => ({
    queryKey: queryKeys.contexts.recent(RECENT_CHAT_LIMIT),
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      listContexts({ origin: 'chat', limit: RECENT_CHAT_LIMIT }, { signal }),
    retry: false,
  }));
  const tasks = createQuery(() => ({ ...recentTasksQuery(), retry: false }));

  const rows = $derived(
    recentChatRows(
      chats.data?.contexts ?? [],
      chatsWithFailedRun(tasks.data?.tasks ?? []),
      CHAT_COPY.untitled,
      CHAT_COPY.messageCount,
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

<HomeCard title={copy.title} link={{ label: copy.link, href: '/chats' }}>
  {#if rows.length > 0}
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
