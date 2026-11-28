<script lang="ts">
  /**
   * Home's Needs attention section: the system problems that need a person (a rule firing, a
   * schedule that missed runs, a hook whose delivery failed, a plugin that did not load, no model
   * provider), as one Cinder `GroupedList`, each row a sentence, a line that says what it is, and
   * one secondary button to the page that deals with it. They are never counted as Needs you, and
   * the provider notice is only here: no banner across the page says it again.
   *
   * With nothing to show the section draws nothing at all (`listIsClear`, owner 2026-11-19: no card
   * says nothing), and its space goes to what has content; the one quiet line Home keeps for a page
   * with nothing waiting is the Spotlight's. The link to Health is the section's action beside the
   * heading (COR-2489). A read that failed says so in the
   * section's own place, with a Try again and no link to Health, and never claims all is well;
   * while it has not answered the section holds Cinder's grouped placeholder rows. Each row's button
   * only opens a page, so it stays live while the server does not answer, as the link to Health
   * does.
   */
  import { GroupedList, GroupedListItem, Skeleton } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { HOME_COPY } from '../../app/copy/home.ts';
  import { listBureauSchedules } from '../../lib/bureau-schedules.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { listIsClear } from '../../lib/worth-showing.ts';
  import { useMinuteClock } from './home-clock.svelte.ts';
  import HomeCard from './home-card.svelte';
  import HomeCardError from './home-card-error.svelte';
  import { useAgentList, useAttentionItems } from './home-queries.svelte.ts';
  import { attentionRows } from './home-rows.ts';

  const copy = HOME_COPY.attention;
  const clock = useMinuteClock();
  const items = useAttentionItems();
  const agents = useAgentList();
  // A missed-runs row says which agent the schedule runs and how often, which the problem itself
  // does not carry; the schedules are read only when one is listed.
  const hasMissedRuns = $derived((items.data ?? []).some((item) => item.kind === 'missed-runs'));
  const schedules = createQuery(() => ({
    queryKey: queryKeys.schedules.bureau(),
    queryFn: ({ signal }: { signal: AbortSignal }) => listBureauSchedules({ signal }),
    enabled: hasMissedRuns,
    retry: false,
  }));

  const rows = $derived(
    attentionRows(items.data ?? [], {
      schedules: schedules.data,
      agents: agents.data,
      now: clock(),
    }),
  );
</script>

<!-- Nothing needs attention: no card says so (owner, 2026-11-19). The link to Health is the
     section's action beside the heading (COR-2489). -->
{#if !(items.data !== undefined && listIsClear(rows))}
  <HomeCard
    title={copy.title}
    class="ib-home-column-card"
    link={items.data === undefined ? undefined : { label: copy.link, href: '/health' }}
  >
    {#if items.data === undefined && items.isError}
      <HomeCardError
        title={HOME_COPY.states.cardFailed.attention}
        error={items.error}
        onRetry={() => void items.refetch()}
      />
    {:else if items.data === undefined}
      <Skeleton variant="grouped" rows={3} action />
    {:else}
      <GroupedList
        class="ib-home-column-list ib-home-column-fill"
        data-home-column-list
        aria-label={copy.listLabel}
      >
        {#each rows as row (row.key)}
          <GroupedListItem
            data-attention={row.key}
            actions={[
              {
                label: row.action.label,
                href: router.href(row.action.href),
              },
            ]}
          >
            {#snippet title()}{row.title}{/snippet}
            {#snippet subtitle()}{row.detail ?? ''}{/snippet}
          </GroupedListItem>
        {/each}
      </GroupedList>
    {/if}
  </HomeCard>
{/if}
