<script lang="ts" module>
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
