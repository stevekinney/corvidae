<script lang="ts">
  /**
   * Home's Needs attention card: the system problems that need a person (a rule firing, a schedule
   * that missed runs, a hook whose delivery failed, a plugin that did not load, no model provider),
   * each a sentence, a line that says what it is, and one secondary button to the page that deals
   * with it. They are never counted as Needs you, and the provider notice is only here: no banner
   * across the page says it again.
   *
   * While the first-run checklist shows, its first step says the provider notice, so `omitProviderNotice`
   * leaves that row out; the rest stay.
   *
   * With nothing to show the card gives way to one line, "Nothing needs attention", and the link to
   * Health stays. A read that failed says so in the card's own place, with a Try again and no link
   * to Health, and never claims all is well; while it has not answered the card holds placeholder
   * rows in the rows' own shape. While the server does not answer each row's button is held like
   * every control that changes something.
   */
  import { Card, DataList, StackedListItem, StatusDot } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { HOME_COPY } from '../../app/copy.ts';
  import { listBureauSchedules } from '../../lib/bureau-schedules.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { useMinuteClock } from './home-clock.svelte.ts';
  import HomeCard from './home-card.svelte';
  import HomeCardError from './home-card-error.svelte';
  import HomeLink from './home-link.svelte';
  import HomeSkeletonRows from './home-skeleton-rows.svelte';
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

  /** Opens `path` in place, and leaves a modified click to the browser. */
  function open(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

{#if items.data !== undefined && rows.length === 0}
  <Card class="ib-home-attention-clear" data-testid="attention-clear">
    <div class="ib-home-attention-clear__line">
      <!-- The sentence beside it says all of this; the dot only draws it. -->
      <span aria-hidden="true"
        ><StatusDot status="success" label={copy.clear.title} labelVisible={false} /></span
      >
      <p class="ib-home-attention-clear__words">
        <strong>{copy.clear.title}</strong>,
        {copy.clear.description}
      </p>
      <HomeLink path="/health" label={copy.link} />
    </div>
  </Card>
{:else}
  <HomeCard
    title={copy.title}
    link={items.data === undefined ? undefined : { label: copy.link, href: '/health' }}
  >
    {#if items.data === undefined && items.isError}
      <HomeCardError
        title={HOME_COPY.states.cardFailed.attention}
        onRetry={() => void items.refetch()}
      />
    {:else if items.data === undefined}
      <HomeSkeletonRows rows={3} action />
    {:else if rows.length > 0}
      <DataList items={rows} key={(row) => row.key} aria-label={copy.listLabel}>
        {#snippet children(row)}
          <StackedListItem
            data-attention={row.key}
            lines
            actions={[
              {
                label: row.action.label,
                href: router.href(row.action.href),
                onclick: (event) => open(event, row.action.href),
                changes: true,
              },
            ]}
          >
            {#snippet title()}{row.title}{/snippet}
            {#snippet meta()}{row.detail ?? ''}{/snippet}
          </StackedListItem>
        {/snippet}
      </DataList>
    {/if}
  </HomeCard>
{/if}

<style>
  .ib-home-attention-clear__line {
    display: flex;
    align-items: center;
    gap: var(--cinder-space-2);
  }

  .ib-home-attention-clear__words {
    flex: 1 1 auto;
    min-inline-size: 0;
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .ib-home-attention-clear__words strong {
    color: var(--cinder-text-default);
    font-size: var(--cinder-text-base);
    font-weight: var(--cinder-font-semibold);
  }
</style>
