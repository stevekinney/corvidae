<script lang="ts">
  import { tick } from 'svelte';

  import Chip from '../chip/chip.svelte';
  import Combobox from '../combobox/combobox.svelte';
  import type { ComboboxFooterContext, ComboboxOption } from '../combobox/combobox.types.ts';
  import NumberInput from '../number-input/number-input.svelte';
  import Select from '../select/select.svelte';
  import ScheduleBuilderTimeInput from './schedule-builder-time-input.svelte';
  import CronFields from './schedule-builder-cron-fields.svelte';
  import type {
    ScheduleBuilderVariant,
    ScheduleIntervalUnit,
    ScheduleRepeats,
  } from './schedule-builder.types.ts';
  import {
    INTERVAL_UNITS,
    customDaysLabel,
    REPEATS_OPTIONS,
    repeatsOptionsFor,
    TIME_ZONE_VISIBLE_COUNT,
    WEEKDAYS,
    timeZoneOffsetLabel,
    type ScheduleDraft,
  } from './schedule-builder.utilities.ts';

  const intervalUnitLabels: Record<ScheduleIntervalUnit, string> = {
    minutes: 'Minutes',
    hours: 'Hours',
  };
  const intervalUnitOptions = INTERVAL_UNITS.map((unit) => ({
    value: unit,
    label: intervalUnitLabels[unit],
  }));

  let {
    baseId,
    variant,
    draft,
    timeZone,
    timeZoneOptions,
    onRepeatsChange,
    onTimeChange,
    onToggleDay,
    onDayOfMonthChange,
    onIntervalCountChange,
    onIntervalUnitChange,
    onTimeZoneChange,
    cronFields,
    onCronFieldChange,
  }: {
    baseId: string;
    variant: ScheduleBuilderVariant;
    draft: ScheduleDraft;
    timeZone: string;
    timeZoneOptions: readonly ComboboxOption[];
    onRepeatsChange: (event: Event) => void;
    onTimeChange: (value: string) => void;
    onToggleDay: (day: number) => void;
    onDayOfMonthChange: (value: number | null) => void;
    onIntervalCountChange: (value: number | null) => void;
    onIntervalUnitChange: (event: Event) => void;
    onTimeZoneChange: (value: string) => void;
    cronFields: string[];
    onCronFieldChange: (index: number, value: string) => void;
  } = $props();

  const repeats = $derived<ScheduleRepeats>(draft.repeats);

  // A weekly schedule on one weekday is its own choice, "Every Friday", with no day chips under
  // it; "Custom days" sits after it and brings the chips back to choose several days (row 65q).
  // Choosing days is the field's own state: the value stays the custom-days schedule it was.
  const CHOOSE_DAYS = 'custom-days:choose';
  let choosingDays = $state(false);
  const namesWeekday = $derived(
    repeats === 'custom-days' &&
      !choosingDays &&
      customDaysLabel(draft.days) !==
        REPEATS_OPTIONS.find((option) => option.value === 'custom-days')?.label,
  );
  const repeatsOptions = $derived(
    namesWeekday
      ? repeatsOptionsFor(draft).flatMap((option) =>
          option.value === 'custom-days'
            ? [option, { value: CHOOSE_DAYS, label: 'Custom days' }]
            : [option],
        )
      : REPEATS_OPTIONS,
  );

  function handleRepeatsChange(event: Event): void {
    const select = event.currentTarget as HTMLSelectElement;
    if (select.value === CHOOSE_DAYS) {
      choosingDays = true;
      // The list loses its Custom days entry once the chips show, so the select is put back on
      // the schedule's own choice after it is drawn again.
      void tick().then(() => {
        select.value = 'custom-days';
      });
      return;
    }
    // A person who picks Custom days from another choice is choosing days, whatever they were.
    choosingDays = select.value === 'custom-days';
    onRepeatsChange(event);
  }
  // An interval counts from its start, so it has no zone; At is for a time of day.
  const showTimeOfDay = $derived(repeats !== 'interval' && repeats !== 'cron');
  const showTimeZone = $derived(repeats !== 'interval');
  const compact = $derived(variant === 'compact');

  // Typing "los angeles" or "los_angeles" finds America/Los_Angeles, and a name such as
  // "central" finds every zone called Central time.
  function filterTimeZone(option: ComboboxOption, query: string): boolean {
    const needle = query.trim().toLowerCase().replaceAll('_', ' ');
    return (
      option.label.toLowerCase().includes(needle) ||
      option.value.toLowerCase().replaceAll('_', ' ').includes(needle)
    );
  }

  function footerText({ matchCount }: ComboboxFooterContext): string {
    const shown = Math.min(matchCount, TIME_ZONE_VISIBLE_COUNT);
    const base = `Showing ${shown} of ${matchCount} ${matchCount === 1 ? 'zone' : 'zones'}.`;
    return shown < matchCount ? `${base} Type to narrow.` : base;
  }
</script>

{#snippet timeZoneField()}
  <Combobox
    id={`${baseId}-time-zone`}
    class="cinder-schedule-builder__time-zone"
    label="Time zone"
    presentation="picker"
    searchPlaceholder="Search time zones"
    options={timeZoneOptions}
    value={timeZone}
    onValueChange={onTimeZoneChange}
    filter={filterTimeZone}
    maxVisibleOptions={TIME_ZONE_VISIBLE_COUNT}
    selectedIndicator="start"
  >
    {#snippet optionMeta(option)}
      <span class="cinder-schedule-builder__offset">{timeZoneOffsetLabel(option.value)}</span>
    {/snippet}
    {#snippet footer(context)}
      <span class="cinder-schedule-builder__time-zone-footer">{footerText(context)}</span>
    {/snippet}
  </Combobox>
{/snippet}

<div
  class="cinder-schedule-builder__field-row"
  data-cinder-fields="primary"
  data-cinder-time-of-day={showTimeOfDay ? '' : undefined}
>
  <div class="cinder-schedule-builder__repeats">
    <Select
      id={`${baseId}-repeats`}
      label="Repeats"
      options={repeatsOptions}
      value={repeats}
      onchange={handleRepeatsChange}
    />
  </div>
  {#if showTimeOfDay}
    <div class="cinder-schedule-builder__time">
      <ScheduleBuilderTimeInput id={`${baseId}-at`} value={draft.time} {onTimeChange} />
    </div>
  {/if}
  {#if compact && showTimeZone}
    <div class="cinder-schedule-builder__zone">{@render timeZoneField()}</div>
  {/if}
  {#if repeats === 'custom-days' && !namesWeekday}
    <div class="cinder-schedule-builder__weekday-group" role="group" aria-label="Days of week">
      {#each WEEKDAYS as day (day.value)}
        <Chip
          mode="toggle"
          density="toolbar"
          label={day.short}
          aria-label={day.long}
          pressed={draft.days.includes(day.value)}
          onPressedChange={() => onToggleDay(day.value)}
        />
      {/each}
    </div>
  {/if}
</div>

{#if repeats === 'monthly'}
  <div class="cinder-schedule-builder__day-of-month">
    <NumberInput
      id={`${baseId}-day-of-month`}
      label="Day of month"
      min={1}
      max={31}
      bind:value={() => draft.dayOfMonth, onDayOfMonthChange}
    />
  </div>
{:else if repeats === 'interval'}
  <div class="cinder-schedule-builder__field-row">
    <div class="cinder-schedule-builder__count">
      <NumberInput
        id={`${baseId}-interval-count`}
        label="Every"
        min={1}
        step={1}
        bind:value={() => draft.intervalCount, onIntervalCountChange}
      />
    </div>
    <div class="cinder-schedule-builder__unit">
      <Select
        id={`${baseId}-interval-unit`}
        label="Unit"
        options={intervalUnitOptions}
        value={draft.intervalUnit}
        onchange={onIntervalUnitChange}
      />
    </div>
  </div>
  <p class="cinder-schedule-builder__help">
    An interval counts from when you create it, so no time zone applies.
  </p>
{:else if repeats === 'cron'}
  <CronFields {baseId} {cronFields} onFieldChange={onCronFieldChange} />
{/if}

{#if !compact && showTimeZone}
  <div class="cinder-schedule-builder__zone">{@render timeZoneField()}</div>
{/if}
