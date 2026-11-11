<script lang="ts">
  /**
   * The runs one schedule missed, as one collapsed amber row among the runs (Cinder's group row):
   * "Missed runs" in the status column, the schedule's name, the day of the first miss as its time,
   * and on line two the schedule's agent and cadence and how many runs it missed since when. Show
   * opens it, in place under its day band, onto each missed occurrence in the viewer's zone, newest
   * first, as plain lines (nothing ran, so none is a run or a link), then a link to the schedule.
   */
  import { Link, StackedListItem, StatusDot } from '@lostgradient/cinder';

  import { TASK_COPY } from '../../../app/copy.ts';
  import { router } from '../../../lib/router.svelte.ts';
  import { missedDay, missedLineTwo, occurrenceWords, type MissedRuns } from './missed-runs.ts';

  interface Props {
    /** The runs the schedule missed. */
    missed: MissedRuns;
    /** The IANA zone the occurrences and the day are written in: the viewer's. */
    zone: string;
    /** The name an agent goes by, from its identifier. */
    agentLabel: (agentName: string) => string;
  }

  let { missed, zone, agentLabel }: Props = $props();

  const copy = TASK_COPY.list.missed;
  const lineTwo = $derived(missedLineTwo(missed, zone, agentLabel));
</script>

<StackedListItem
  data-missed-schedule={missed.scheduleId}
  tone="warning"
  tooltip={missed.title}
  metaTooltip={lineTwo}
>
  {#snippet status()}<StatusDot word="Missed runs" />{/snippet}
  {#snippet title()}{missed.title}{/snippet}
  {#snippet time()}
    <time datetime={new Date(missed.since).toISOString()}>{missedDay(missed.since, zone)}</time>
  {/snippet}
  {#snippet meta()}{lineTwo}{/snippet}
  {#snippet details()}
    <ul class="ib-missed-runs__occurrences" aria-label={copy.occurrencesLabel}>
      {#each missed.occurrences as at, index (index)}
        <li><time datetime={new Date(at).toISOString()}>{occurrenceWords(at, zone)}</time></li>
      {/each}
    </ul>
    <Link href={router.href(missed.schedulePath)}>{copy.viewSchedule}</Link>
  {/snippet}
</StackedListItem>
