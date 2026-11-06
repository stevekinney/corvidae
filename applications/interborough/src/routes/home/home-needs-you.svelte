<script lang="ts">
  /**
   * Home's Needs you card: the reviews waiting on you (approvals, questions and workflow reviews,
   * the ones Reviews lists and its badge counts), oldest first, each with a secondary button that
   * opens it in Reviews: Answer for a question, Review for the rest. Line two says what kind of
   * review it is first, then who asked, then whether the call can be undone, then how long it has
   * waited. With nothing waiting the card says so, and the link to Reviews stays.
   *
   * It reads the same list as Reviews (`waitingReviewsQuery`), so the two cannot disagree. A read
   * that fails is that card's own failure and no other card is held.
   */
  import { DataList, EmptyState, StackedListItem } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { HOME_COPY } from '../../app/copy.ts';
  import { getAgentCatalog } from '../../lib/agent-definitions.ts';
  import { waitedFor } from '../../lib/format/clock.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { waitingReviewsQuery } from '../reviews/reviews-data.ts';
  import { useMinuteClock } from './home-clock.svelte.ts';
  import HomeCard from './home-card.svelte';
  import HomeLink from './home-link.svelte';
  import { useAgentList } from './home-queries.svelte.ts';
  import { NEEDS_YOU_ROW_LIMIT, needsYouRows } from './home-rows.ts';

  const copy = HOME_COPY.needsYou;
  const clock = useMinuteClock();
  const reviews = waitingReviewsQuery();
  const agents = useAgentList();
  // Which tools are dangerous, for "Can’t be undone". A catalog that cannot be read only leaves the
  // phrase out.
  const catalog = createQuery(() => ({
    queryKey: queryKeys.agents.catalog(),
    queryFn: ({ signal }: { signal: AbortSignal }) => getAgentCatalog({ signal }),
    retry: false,
  }));

  const rows = $derived(
    needsYouRows(reviews.data ?? [], { agents: agents.data, tools: catalog.data?.tools }),
  );
  const shown = $derived(rows.slice(0, NEEDS_YOU_ROW_LIMIT));

  /** Opens `path` in place, and leaves a modified click to the browser. */
  function open(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

<!-- With nothing waiting the link to Reviews moves into the empty state, at the end of its line. -->
<HomeCard
  title={copy.title}
  link={reviews.data !== undefined && rows.length === 0
    ? undefined
    : { label: copy.link, href: '/reviews' }}
>
  {#if reviews.data !== undefined && rows.length === 0}
    <EmptyState
      kind="done"
      layout="row"
      headingLevel={3}
      title={copy.empty.title}
      description={copy.empty.description}
    >
      {#snippet action()}
        <HomeLink path="/reviews" label={copy.link} />
      {/snippet}
    </EmptyState>
  {:else if shown.length > 0}
    <DataList items={shown} key={(row) => row.key} aria-label={copy.listLabel}>
      {#snippet children(row)}
        <StackedListItem
          data-review={row.key}
          lines
          actions={[
            {
              label: row.action,
              href: router.href(row.href),
              onclick: (event) => open(event, row.href),
            },
          ]}
        >
          {#snippet title()}{row.title}{/snippet}
          {#snippet meta()}
            {row.kind}
            {#if row.agent !== undefined}· {row.agent}{/if}
            {#if row.cantBeUndone}· {copy.cantBeUndone}{/if}
            · {waitedFor(row.requestedAt, clock())}
          {/snippet}
        </StackedListItem>
      {/snippet}
    </DataList>
    {#if rows.length > shown.length}
      <p class="ib-home-more">
        <HomeLink path="/reviews" label={copy.more(rows.length - shown.length)} />
      </p>
    {/if}
  {/if}
</HomeCard>

<style>
  .ib-home-more {
    margin: 0;
    padding: var(--cinder-space-3) var(--cinder-space-4);
    font-size: var(--cinder-text-sm);
  }
</style>
