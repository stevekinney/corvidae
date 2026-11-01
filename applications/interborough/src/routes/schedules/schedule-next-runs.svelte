<script lang="ts">
  /**
   * A schedule's next runs, soonest first, each in the zone the schedule is read in with the zone
   * named, counted from the schedule's own `nextFireAt`. "Skip the next one" makes the next run that would start start nothing, and the one after
   * it run as usual; the run it skipped stays in the list, marked, until its time has passed, and
   * skipping again meanwhile would change nothing, so the button goes while one is skipped. A
   * schedule that is paused or cancelled has no next runs, and says so.
   */
  import { Badge, Button, EmptyState } from '@lostgradient/cinder';

  import { SCHEDULE_COPY } from '../../app/copy.ts';
  import { scheduleStatusWord } from '../../lib/status.ts';
  import {
    formatInZone,
    scheduleZone,
    upcomingFires,
    zoneLabel,
    type ScheduleTiming,
  } from './schedule-time.ts';

  interface Props {
    schedule: ScheduleTiming;
    /** How many runs to list. */
    count?: number;
    /** Whether the person may skip: the schedule is one an owner writes, and the scope is held. */
    canSkip: boolean;
    /** A write is in flight. */
    busy: boolean;
    /** Skips the run the button sits beside, named by its time in milliseconds since the epoch. */
    onSkip: (occurrence: number) => void;
    /** Where the list counts from only when the schedule carries no `nextFireAt`; a test can fix it. */
    now?: number;
  }

  let { schedule, count = 5, canSkip, busy, onSkip, now }: Props = $props();

  const copy = SCHEDULE_COPY.detail;
  const zone = $derived(scheduleZone(schedule));
  // The list follows the schedule the engine reports, so it is read again whenever that changes: a
  // fire moves `nextFireAt`, and a clock frozen at mount would keep offering a time that has passed.
  const fires = $derived(upcomingFires(schedule, count, now));
  const anySkipped = $derived(fires.some((fire) => fire.skipped));
  /** The first run that will start one: the one "Skip the next one" would skip. */
  const next = $derived(fires.find((fire) => !fire.skipped));
</script>

<section class="ib-schedule__section" aria-labelledby="ib-schedule-next-heading">
  <div class="ib-schedule__section-head">
    <h2 id="ib-schedule-next-heading" class="ib-records__subheading">{copy.nextRunsHeading}</h2>
    <p class="ib-records__muted" data-testid="schedule-zone">
      {copy.nextRunsCaption(zoneLabel(zone))}
    </p>
  </div>
  {#if fires.length === 0}
    <EmptyState
      kind="done"
      size="compact"
      title={copy.noNextRuns.title}
      description={copy.noNextRuns.description(scheduleStatusWord(schedule.status))}
      headingLevel={3}
    />
  {:else}
    <ol class="ib-schedule__fires" data-testid="schedule-next-fires">
      {#each fires as fire (fire.at)}
        <li
          class="ib-schedule__fire"
          data-skipped={fire.skipped ? 'true' : 'false'}
          data-next={fire === next ? 'true' : 'false'}
        >
          <time datetime={new Date(fire.at).toISOString()}>{formatInZone(fire.at, zone)}</time>
          {#if fire.skipped}
            <Badge variant="neutral">{copy.skipped}</Badge>
          {:else if fire === next && canSkip && !anySkipped}
            <Button
              data-changes
              variant="ghost"
              size="sm"
              disabled={busy}
              onclick={() => onSkip(fire.at)}>{copy.skipNext}</Button
            >
          {/if}
        </li>
      {/each}
    </ol>
    {#if anySkipped}
      <p class="ib-records__muted">{copy.skippedNote}</p>
    {/if}
  {/if}
</section>
