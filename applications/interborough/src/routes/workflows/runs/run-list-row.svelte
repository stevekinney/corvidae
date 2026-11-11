<script lang="ts">
  /**
   * One run on `/runs`, as the status-first two-line row every list shares (Cinder's
   * `StackedListItem`): the status word leads in its fixed column, then the title (two lines at
   * most, the whole title as its tooltip) and the time the run started on line one, and line two
   * says what kind of run it is, which agent ran it and how it went (`runLineTwo`). The whole row is
   * one link to the run's page; the list around it follows the link in place (`followLinks`). A
   * running row keeps its place: its duration follows `now`, and its word changes where it stands.
   */
  import { StackedListItem, StatusDot } from '@lostgradient/cinder';

  import { clockTime } from '../../../lib/format/clock.ts';
  import { router, workflowDetailPath } from '../../../lib/router.svelte.ts';
  import { runLineTwo, runStatusWord, type RunRow } from './run-rows.ts';

  interface Props {
    /** The run. */
    row: RunRow;
    /** The clock a wait and a running duration are counted to, in epoch milliseconds. */
    now: number;
    /** The IANA zone the times are written in: the viewer's. */
    zone: string;
    /** The name an agent goes by, from its identifier. */
    agentLabel: (agentName: string) => string;
  }

  let { row, now, zone, agentLabel }: Props = $props();

  const word = $derived(runStatusWord(row));
  const lineTwo = $derived(runLineTwo(row, { now, zone, agentLabel }));
</script>

<StackedListItem
  data-run={row.id}
  data-status={word}
  href={router.href(workflowDetailPath(row.id))}
  tooltip={row.title}
  metaTooltip={lineTwo}
>
  {#snippet status()}<StatusDot {word} />{/snippet}
  {#snippet title()}{row.title}{/snippet}
  {#snippet time()}
    <time datetime={new Date(row.startedAt).toISOString()}>{clockTime(row.startedAt, zone)}</time>
  {/snippet}
  {#snippet meta()}{lineTwo}{/snippet}
</StackedListItem>
