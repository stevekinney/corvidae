<script lang="ts">
  /**
   * The When block shared by the pages that make a schedule: the new schedule page and the run
   * setup page. It is Cinder's `ScheduleBuilder` (Repeats, At, Time zone, the schedule read back as
   * a sentence, and the next runs in the chosen zone) in a region the page can ask about.
   *
   * The builder keeps the last cadence it emitted while a custom field is out of range, so the
   * value the page holds is not the one on screen. A page asks `isInvalid` before it saves and
   * refuses while it says so, which is the one place that rule lives.
   */
  import { ScheduleBuilder, type ScheduleValue } from '@lostgradient/cinder';

  import { computeNextFires } from '../../lib/format/cron-preview.ts';
  import { shownCadenceIsInvalid } from './cadence.ts';

  interface Props {
    /** The cadence the builder opens with, and shows. */
    value: ScheduleValue;
    /** Takes each valid cadence the builder commits. */
    onValueChange: (next: ScheduleValue) => void;
    /** The label of the builder. */
    label: string;
  }

  let { value, onValueChange, label }: Props = $props();

  let region = $state<HTMLElement>();

  /** Whether a field the builder shows is out of range, so that the cadence a page holds is not the one on screen. */
  export function isInvalid(): boolean {
    return shownCadenceIsInvalid(region);
  }
</script>

<div class="ib-schedule-when" bind:this={region} data-testid="schedule-when">
  <ScheduleBuilder {value} {onValueChange} {computeNextFires} {label} />
</div>

<style>
  .ib-schedule-when {
    min-width: 0;
  }
</style>
