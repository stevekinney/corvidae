<script lang="ts">
  /**
   * Home's Running now card: the runs going at this moment, under Needs you, each with its title,
   * a line that says it is running (a blue dot, then the words), what started it, which agent runs
   * and when it began, and a
   * "View run" button. It is the other half of the Running now count, read from the same answer
   * (`useRunningTasks`), so the two cannot disagree; a run parked on a review or a question is
   * waiting on a person, so it is in neither. At zero the card is gone, which is the page's call:
   * this card draws nothing for an empty list.
   */
  import { DataList, StackedListItem, StatusDot } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { HOME_COPY } from '../../app/copy/home.ts';
  import type { TaskView } from '../../lib/bureau-tasks.ts';
  import { listBureauSchedules } from '../../lib/bureau-schedules.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { useMinuteClock } from './home-clock.svelte.ts';
  import HomeCard from './home-card.svelte';
  import HomeLink from './home-link.svelte';
  import { openInApplication } from './home-navigation.ts';
  import { useAgentList, useRecentChats } from './home-queries.svelte.ts';
  import { RUNNING_ROW_LIMIT, runningRows } from './home-rows.ts';

  interface HomeRunningNowProps {
    /** The runs running now, which the page has already read. */
    tasks: readonly TaskView[];
  }

  let { tasks }: HomeRunningNowProps = $props();

  const copy = HOME_COPY.running;
  const clock = useMinuteClock();
  const agents = useAgentList();
  const chats = useRecentChats();
  // A run a schedule started is titled by the schedule's name, which the run does not carry.
  const hasScheduledRun = $derived(
    tasks.some((task) => task.origin?.kind === 'schedule' || task.actor === 'system:scheduler'),
  );
  const schedules = createQuery(() => ({
    queryKey: queryKeys.schedules.bureau(),
    queryFn: ({ signal }: { signal: AbortSignal }) => listBureauSchedules({ signal }),
    enabled: hasScheduledRun,
    retry: false,
  }));

  const rows = $derived(
    runningRows(tasks, {
      chats: chats.data?.contexts ?? [],
      schedules: schedules.data,
      agents: agents.data,
      now: clock(),
    }),
  );
  const shown = $derived(rows.slice(0, RUNNING_ROW_LIMIT));
</script>

<HomeCard title={copy.title} link={{ label: copy.link, href: '/runs' }}>
  <DataList items={shown} key={(row) => row.key} aria-label={copy.listLabel}>
    {#snippet children(row)}
      <StackedListItem
        data-run={row.key}
        lines
        actions={[
          {
            label: copy.viewRun,
            href: router.href(row.href),
            onclick: (event) => openInApplication(event, row.href),
          },
        ]}
      >
        {#snippet title()}{row.title}{/snippet}
        {#snippet meta()}
          <!-- The words say it is running; the dot only draws it. -->
          <span class="ib-home-running__dot" aria-hidden="true"
            ><StatusDot status="info" label={copy.status} labelVisible={false} /></span
          >
          {row.line}
        {/snippet}
      </StackedListItem>
    {/snippet}
  </DataList>
  {#if rows.length > shown.length}
    <p class="ib-home-more">
      <HomeLink path="/runs" label={copy.more(rows.length - shown.length)} />
    </p>
  {/if}
</HomeCard>

<style>
  .ib-home-running__dot {
    display: inline-flex;
    margin-inline-end: var(--cinder-space-1);
    vertical-align: middle;
  }

  .ib-home-more {
    margin: 0;
    padding: var(--cinder-space-3) var(--cinder-space-4);
    font-size: var(--cinder-text-sm);
  }
</style>
