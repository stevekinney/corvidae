<script lang="ts" module>
  /**
   * @cinder
   * @category data-display
   * @status beta
   * @purpose Display of a recurring weekly schedule as one row per day with a day, an unbroken time range and a description, today highlighted and a live window marked with a pill.
   * @tag schedule
   * @tag week
   * @tag recurring
   * @useWhen Showing the days and hours a place or event recurs, such as happy-hour windows, on a detail page.
   * @useWhen Showing a window that crosses midnight without breaking its time range across lines.
   * @avoidWhen Letting the user edit a schedule or a cron expression — use schedule-builder.
   * @avoidWhen Showing dated events on a calendar grid — use calendar.
   * @rationale Nearest alternative: ScheduleBuilder — WeekSchedule only displays; it has no inputs.
   */
  export type { WeekScheduleDay, WeekScheduleProps } from './week-schedule.types.ts';
</script>

<script lang="ts">
  import { classNames } from '../../utilities/class-names.ts';
  import type { WeekScheduleProps } from './week-schedule.types.ts';

  let {
    days,
    label,
    liveLabel = 'On now',
    class: className,
    ...rest
  }: WeekScheduleProps = $props();
</script>

<ol {...rest} class={classNames('cinder-week-schedule', className)} aria-label={label}>
  {#each days as entry, index (index)}
    <li
      class="cinder-week-schedule__row"
      data-today={entry.today ? '' : undefined}
      aria-current={entry.today ? 'date' : undefined}
    >
      <span class="cinder-week-schedule__day">{entry.day}</span>
      <span class="cinder-week-schedule__times"
        ><time>{entry.start}</time>{' – '}<time>{entry.end}</time>{#if entry.endsNextDay}<span
            class="cinder-week-schedule__next-day">{' next day'}</span
          >{/if}</span
      >
      <span class="cinder-week-schedule__description">
        {#if entry.live}<span class="cinder-week-schedule__live">{liveLabel}</span>{/if}
        {#if entry.description}{entry.description}{/if}
      </span>
    </li>
  {/each}
</ol>
