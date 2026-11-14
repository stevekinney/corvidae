<script lang="ts">
  /**
   * Home's Needs attention section: the system problems that need a person (a rule firing, a
   * schedule that missed runs, a hook whose delivery failed, a plugin that did not load, no model
   * provider), as one Cinder `GroupedList`, each row a sentence, a line that says what it is, and
   * one secondary button to the page that deals with it. They are never counted as Needs you, and
   * the provider notice is only here: no banner across the page says it again.
   *
   * While the first-run checklist shows, its first step says the provider notice, so `omitProviderNotice`
   * leaves that row out; the rest stay.
   *
   * With nothing to show the section keeps its heading over one row, Cinder's `EmptyState` in its
   * row layout: "Nothing needs attention", with the link to Health at the end of it. (Without the
   * heading the row read as part of the section above it.) A read that failed says so in the
   * section's own place, with a Try again and no link to Health, and never claims all is well;
   * while it has not answered the section holds Cinder's grouped placeholder rows. Each row's button
   * only opens a page, so it stays live while the server does not answer, as the link to Health
   * does.
   */
  import { EmptyState, GroupedList, GroupedListItem, Link, Skeleton } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { HOME_COPY } from '../../app/copy/home.ts';
  import { listBureauSchedules } from '../../lib/bureau-schedules.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { useMinuteClock } from './home-clock.svelte.ts';
  import HomeCard from './home-card.svelte';
  import HomeCardError from './home-card-error.svelte';
  import { openInApplication } from './home-navigation.ts';
  import { useAgentList, useAttentionItems } from './home-queries.svelte.ts';
  import { attentionRows } from './home-rows.ts';

  interface HomeNeedsAttentionProps {
    /** Leave the "No model provider connected" row out, because the first-run checklist says it. */
    omitProviderNotice?: boolean;
  }

  let { omitProviderNotice = false }: HomeNeedsAttentionProps = $props();

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
    attentionRows(
      omitProviderNotice
        ? (items.data ?? []).filter((item) => item.kind !== 'no-provider')
        : (items.data ?? []),
      {
        schedules: schedules.data,
        agents: agents.data,
        now: clock(),
      },
    ),
  );
</script>

<!-- With nothing to show the link to Health moves into the clear row, at the end of its line, so
     the section never says it twice. -->
<HomeCard
  title={copy.title}
  link={items.data === undefined || rows.length === 0
    ? undefined
    : { label: copy.link, href: '/health' }}
>
  {#if items.data === undefined && items.isError}
    <HomeCardError
      title={HOME_COPY.states.cardFailed.attention}
      onRetry={() => void items.refetch()}
    />
  {:else if items.data === undefined}
    <Skeleton variant="grouped" rows={3} action />
  {:else if rows.length === 0}
    <div data-testid="attention-clear">
      <EmptyState
        kind="done"
        layout="row"
        headingLevel={3}
        title={copy.clear.title}
        description={copy.clear.description}
      >
        {#snippet action()}
          <Link
            variant="more"
            href={router.href('/health')}
            onclick={(event: MouseEvent) => openInApplication(event, '/health')}>{copy.link}</Link
          >
        {/snippet}
      </EmptyState>
    </div>
  {:else}
    <GroupedList aria-label={copy.listLabel}>
      {#each rows as row (row.key)}
        <GroupedListItem
          data-attention={row.key}
          actions={[
            {
              label: row.action.label,
              href: router.href(row.action.href),
              onclick: (event) => openInApplication(event, row.action.href),
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
