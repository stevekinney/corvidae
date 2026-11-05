<script lang="ts">
  /**
   * One schedule as a row of the Schedules list, Cinder's status-first two-line row: the status dot
   * and word, the bold title and the next run on line one, and line two kind first. The whole row is
   * the link to the schedule, so there is no menu of actions here: pausing, editing and deleting
   * are on the schedule's own page. On a phone the status moves to line two beside the kind and the
   * next run stays at the right of line one, and a third line says why the schedule will not run
   * and what happened last, ending in the cadence, wrapping so nothing on it is cut.
   */
  import { StackedListItem, StatusDot } from '@lostgradient/cinder';

  import { router, scheduleDetailPath } from '../../lib/router.svelte.ts';
  import ScheduleLastFire from './schedule-last-fire.svelte';
  import ScheduleLine from './schedule-line.svelte';
  import type { ScheduleRow } from './schedule-row-model.ts';

  interface Props {
    row: ScheduleRow;
    /** The viewport is a phone: the status leads line two, and a third line says the rest. */
    phone: boolean;
  }

  let { row, phone }: Props = $props();

  const next = $derived(phone ? row.nextPhone : row.next);
  // A schedule that missed runs says so instead, and one that never ran has nothing to say.
  const showLastRan = $derived(row.statusKey !== 'missed' && row.lastFireAt !== undefined);
  // Line two as plain text, for the tooltip that carries it whole when it is cut.
  const lineTwoText = $derived(
    row.lineTwo.map((segment) => segment.map((part) => part.text).join('')).join(' · '),
  );
</script>

{#snippet lastRun()}
  <ScheduleLastFire scheduleId={row.id} lastFireAt={row.lastFireAt} />
{/snippet}
{#snippet phoneDetail()}
  <span data-testid="schedule-line-three">
    <ScheduleLine segments={row.phoneLineThree} tail={phoneTail} />
  </span>
{/snippet}
{#snippet phoneTail()}
  {#if showLastRan}
    <ScheduleLastFire scheduleId={row.id} lastFireAt={row.lastFireAt} phone />{' · '}
  {/if}
  {row.phoneCadence}
{/snippet}

<StackedListItem
  href={router.href(scheduleDetailPath(row.id))}
  tooltip={row.title}
  {...phone ? { detail: phoneDetail } : { metaTooltip: lineTwoText }}
  data-schedule={row.id}
  data-status-key={row.statusKey}
  data-status-word={row.statusWord}
>
  {#snippet status()}<StatusDot word={row.statusWord} size="sm" />{/snippet}
  {#snippet title()}{row.title}{/snippet}
  {#snippet time()}
    <span class="ib-schedule-next" data-tone={next.tone} data-testid="schedule-next"
      >{next.text}</span
    >
  {/snippet}
  {#snippet meta()}
    {#if phone}
      <ScheduleLine segments={row.phoneLineTwo} />
    {:else}
      <ScheduleLine segments={row.lineTwo} tail={lastRun} />
    {/if}
  {/snippet}
</StackedListItem>
