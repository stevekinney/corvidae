<script lang="ts">
  /**
   * The runs one schedule missed, as one collapsed amber row among the runs (Cinder's group row):
   * "Missed runs" in the status column, the schedule's name, the day of the first miss as its time,
   * and on line two the schedule's agent and cadence and how many runs it missed since when. Show
   * opens it, in place under its day band, onto each missed occurrence in the viewer's zone, newest
   * first, as plain lines (nothing ran, so none is a run or a link), then a link to the schedule.
   */
  import { Link, StackedListItem, StatusDot } from '@lostgradient/cinder';
  import { MediaQuery } from 'svelte/reactivity';

  import { TASK_COPY } from '../../../app/copy/tasks.ts';
  import { router } from '../../../lib/router.svelte.ts';
  import { missedDay, missedLineTwo, occurrenceWords, type MissedRuns } from './missed-runs.ts';

  /** From this width the row has room for the schedule's cadence (row 09q); below it, a tablet's. */
  const WIDE_QUERY = '(min-width: 1024px)';

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
  // Line two as each width's row draws it: the whole line from 1024px, without the cadence on a
  // tablet (05x), and on a phone the few words of Cinder's compact line two (05w). The tooltip is
  // always the whole line.
  const wide = new MediaQuery(WIDE_QUERY, true);
  const lineTwo = $derived(missedLineTwo(missed, zone, agentLabel, 'wide'));
  const shownLine = $derived(
    wide.current ? lineTwo : missedLineTwo(missed, zone, agentLabel, 'tablet'),
  );
  const compactLine = $derived(missedLineTwo(missed, zone, agentLabel, 'compact'));
</script>

<!-- The Runs list fills the page's content column, so its rows take the phone form from the
     window (`phoneWidth="viewport"`): on a tablet beside the rail the status leads in its column
     (05x), and on a phone it leads line two, once (`wrapMeta`, 05w). -->
<StackedListItem
  data-missed-schedule={missed.scheduleId}
  tone="warning"
  phoneWidth="viewport"
  wrapMeta
  tooltip={missed.title}
  metaTooltip={lineTwo}
>
  {#snippet status()}<StatusDot word="Missed runs" qualifier={missed.count} />{/snippet}
  {#snippet title()}{missed.title}{/snippet}
  {#snippet time()}
    <time datetime={new Date(missed.since).toISOString()}>{missedDay(missed.since, zone)}</time>
  {/snippet}
  {#snippet meta()}{shownLine}{/snippet}
  {#snippet metaCompact()}{compactLine}{/snippet}
  {#snippet details()}
    <ul class="ib-missed-runs__occurrences" aria-label={copy.occurrencesLabel}>
      {#each missed.occurrences as at, index (index)}
        <li><time datetime={new Date(at).toISOString()}>{occurrenceWords(at, zone)}</time></li>
      {/each}
    </ul>
    <Link href={router.href(missed.schedulePath)}>{copy.viewSchedule}</Link>
  {/snippet}
</StackedListItem>
