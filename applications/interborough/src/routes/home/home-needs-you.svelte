<script lang="ts">
  /**
   * Home's Needs you section: the reviews waiting on you (approvals, questions and workflow reviews,
   * the ones Reviews lists and its badge counts), oldest first, as one Cinder `GroupedList`, each row
   * ending in a secondary button that opens it in Reviews: Answer for a question, Review for the
   * rest. The subtitle says what kind of review it is first, then who asked, then whether the call
   * can be undone, then how long it has waited. With nothing waiting the section says so, and the
   * link to Reviews stays. More than Home lists ends the list in one more row, a link to Reviews.
   *
   * It reads the same list as Reviews (`waitingReviewsQuery`), and the Spotlight above reads it too,
   * so none of them can disagree. A read that fails is this section's own failure, said in place
   * with a Try again, and no other section is held; while it has not answered the section holds
   * Cinder's grouped placeholder rows in the rows' own shape. On a phone each button is full width
   * under the row's text, and while the server does not answer each is held like every control
   * that changes something.
   */
  import { EmptyState, GroupedList, GroupedListItem, Skeleton } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { HOME_COPY } from '../../app/copy/home.ts';
  import { getAgentCatalog } from '../../lib/agent-definitions.ts';
  import { followLinks } from '../../lib/follow-links.ts';
  import { waitedFor } from '../../lib/format/clock.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { waitingReviewsQuery } from '../reviews/reviews-data.ts';
  import { useMinuteClock } from './home-clock.svelte.ts';
  import HomeCard from './home-card.svelte';
  import HomeCardError from './home-card-error.svelte';
  import HomeLink from './home-link.svelte';
  import { openInApplication } from './home-navigation.ts';
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
</script>

<!-- With nothing waiting the link to Reviews moves into the empty state, at the end of its line. -->
<HomeCard
  title={copy.title}
  link={reviews.data === undefined || rows.length === 0
    ? undefined
    : { label: copy.link, href: '/reviews' }}
>
  {#if reviews.data === undefined && reviews.isError}
    <HomeCardError
      title={HOME_COPY.states.cardFailed.needsYou}
      onRetry={() => void reviews.refetch()}
    />
  {:else if reviews.data === undefined}
    <Skeleton variant="grouped" rows={2} action />
  {:else if rows.length === 0}
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
  {:else}
    <div {@attach followLinks}>
      <GroupedList aria-label={copy.listLabel}>
        {#each shown as row (row.key)}
          <GroupedListItem
            data-review={row.key}
            actions={[
              {
                label: row.action,
                href: router.href(row.href),
                onclick: (event) => openInApplication(event, row.href),
                changes: true,
              },
            ]}
          >
            {#snippet title()}{row.title}{/snippet}
            {#snippet subtitle()}
              {row.kind}{#if row.agent !== undefined}, {row.agent}{/if}{#if row.cantBeUndone}, {copy.cantBeUndone}{/if},
              {waitedFor(row.requestedAt, clock())}
            {/snippet}
          </GroupedListItem>
        {/each}
        {#if rows.length > shown.length}
          <GroupedListItem data-more href={router.href('/reviews')}>
            {#snippet title()}{copy.more(rows.length - shown.length)}{/snippet}
          </GroupedListItem>
        {/if}
      </GroupedList>
    </div>
  {/if}
</HomeCard>
