<script lang="ts" module>
  /** Test-only fixture: past runs as status-first rows, a skipped occurrence and an open band. */
  export type TimelineRunsFixtureProps = {
    onexpandedchange?: ((open: boolean) => void) | undefined;
    expanded?: boolean | undefined;
  };
</script>

<script lang="ts">
  import Timeline from '../../components/timeline/timeline.svelte';
  import type { TimelineEntry } from '../../components/timeline/timeline.types.ts';

  let { onexpandedchange, expanded = false }: TimelineRunsFixtureProps = $props();

  const entries: TimelineEntry[] = $derived([
    {
      id: 'skipped',
      datetime: '2026-11-03T09:00:00Z',
      timestamp: 'Tue Nov 3, 3:00 AM',
      title: 'in 16 hours',
      tone: 'pending',
      struck: true,
    },
    {
      id: 'now',
      kind: 'now',
      datetime: '2026-11-02T16:46:00Z',
      timestamp: 'Mon Nov 2, 10:46 AM',
      title: 'Now',
    },
    {
      id: 'missed',
      kind: 'band',
      tone: 'warning',
      datetime: '2026-11-02T09:00:00Z',
      timestamp: 'Mon Nov 2, 3:00 AM',
      title: 'Missed 4 times since Oct 30',
      detail: 'Interborough was off',
      expandLabel: 'Show each',
      expanded,
    },
    {
      id: 'miss',
      datetime: '2026-11-02T09:00:00Z',
      timestamp: 'Mon Nov 2, 3:00 AM',
      title: 'Missed · Interborough was off',
      tone: 'warning',
      plain: true,
    },
    {
      id: 'running',
      kind: 'run',
      datetime: '2026-11-02T16:45:00Z',
      timestamp: 'Mon Nov 2, 10:45 AM',
      title: 'Running',
      status: 'Running',
      detail: 'Started with Run now · Collecting merged changes',
      duration: '38 s so far',
      href: '/runs/running',
    },
    {
      id: 'done',
      kind: 'run',
      datetime: '2026-10-29T09:00:00Z',
      timestamp: 'Thu Oct 29, 4:00 AM',
      title: 'Done',
      status: 'Done',
      duration: '14 s',
      href: '/runs/done',
    },
    {
      id: 'plain',
      kind: 'run',
      datetime: '2026-10-28T09:00:00Z',
      timestamp: 'Wed Oct 28, 4:00 AM',
      title: 'Done',
      status: 'Done',
    },
  ]);
</script>

<Timeline
  {entries}
  variant="list"
  label="Runs"
  onexpandedchange={(_entry, open) => onexpandedchange?.(open)}
>
  {#snippet children(entry)}
    {#if entry.kind === 'band'}<span data-testid="missed-detail">each miss</span>{/if}
  {/snippet}
</Timeline>
