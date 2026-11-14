<script lang="ts">
  /**
   * Home's Running now section: the runs going at this moment, under Needs you, as one Cinder
   * `GroupedList`. Each row has its title, then a subtitle that leads with the status (a dot and the
   * word Running) and says what started it, which agent runs and when it began, and a "View run"
   * button. It reads the same answer as the page (`useRunningTasks`); a run parked on a review or a
   * question is waiting on a person, so it is not here. At zero the section is gone, which is the
   * page's call: this section draws nothing for an empty list. More than Home lists ends the list in
   * one more row, a link to Runs.
   */
  import { GroupedList, GroupedListItem, StatusDot } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { HOME_COPY } from '../../app/copy/home.ts';
  import type { TaskView } from '../../lib/bureau-tasks.ts';
  import { listBureauSchedules } from '../../lib/bureau-schedules.ts';
  import { followLinks } from '../../lib/follow-links.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { useMinuteClock } from './home-clock.svelte.ts';
  import HomeCard from './home-card.svelte';
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
  <div {@attach followLinks}>
    <GroupedList aria-label={copy.listLabel}>
      {#each shown as row (row.key)}
        <GroupedListItem
          data-run={row.key}
          actions={[
            {
              label: copy.viewRun,
              href: router.href(row.href),
              onclick: (event) => openInApplication(event, row.href),
            },
          ]}
        >
          {#snippet title()}{row.title}{/snippet}
          {#snippet subtitle()}<StatusDot status="info" label={copy.status} />, {row.detail}{/snippet}
        </GroupedListItem>
      {/each}
      {#if rows.length > shown.length}
        <GroupedListItem data-more href={router.href('/runs')}>
          {#snippet title()}{copy.more(rows.length - shown.length)}{/snippet}
        </GroupedListItem>
      {/if}
    </GroupedList>
  </div>
</HomeCard>
