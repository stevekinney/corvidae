<script lang="ts">
  /**
   * Home's Needs you list: the reviews waiting on you (approvals, questions and workflow reviews,
   * the ones Reviews lists and its badge counts), oldest first, as one Cinder `GroupedList`, each row
   * ending in a secondary button that opens it in Reviews: Answer for a question, Review for the
   * rest. The subtitle says what kind of review it is first, then who asked, then whether the call
   * can be undone, then how long it has waited. More than Home lists ends the list in one more row,
   * a link to Reviews.
   *
   * The Spotlight above ("2 need you", `home-focus.svelte`) is this list's title, with the link to
   * Reviews beside it, so the list draws no heading of its own and the page says "needs you" once;
   * the list keeps its accessible name. With nothing waiting the Spotlight ("Nothing needs you")
   * stands alone and this draws nothing.
   *
   * It reads the same list as Reviews (`waitingReviewsQuery`), and the Spotlight reads it too, so
   * none of them can disagree. A read that fails leaves the Spotlight out, so this takes its
   * "Needs you" heading back and says the failure in place with a Try again, and no other section is
   * held; while it has not answered it holds Cinder's grouped placeholder rows in the rows' own
   * shape, under the Spotlight's placeholder. On a phone each button drops under the row's text at
   * its own width. Each only opens a page in Reviews, so it stays live while the server does not
   * answer, as the link to Reviews does.
   */
  import { GroupedList, GroupedListItem, Skeleton } from '@lostgradient/cinder';
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

{#if reviews.data === undefined && reviews.isError}
  <!-- No Spotlight stands over it, so the section has its own heading. -->
  <HomeCard title={copy.title}>
    <HomeCardError
      title={HOME_COPY.states.cardFailed.needsYou}
      onRetry={() => void reviews.refetch()}
    />
  </HomeCard>
{:else if reviews.data === undefined}
  <div data-home-card={copy.title}>
    <Skeleton variant="grouped" rows={2} action />
  </div>
{:else if rows.length > 0}
  <div data-home-card={copy.title} {@attach followLinks}>
    <GroupedList aria-label={copy.listLabel}>
      {#each shown as row (row.key)}
        <GroupedListItem
          data-review={row.key}
          actions={[
            {
              label: row.action,
              href: router.href(row.href),
              onclick: (event) => openInApplication(event, row.href),
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
