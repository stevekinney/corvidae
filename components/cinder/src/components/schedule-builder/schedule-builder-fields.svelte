<script lang="ts">
  import Chip from '../chip/chip.svelte';
  import Combobox from '../combobox/combobox.svelte';
  import type { ComboboxOption } from '../combobox/combobox.types.ts';
  import NumberInput from '../number-input/number-input.svelte';
  import Select from '../select/select.svelte';
  import TimeField from '../time-field/time-field.svelte';
  import CronEditorFields from './schedule-builder-cron-editor.svelte';
  import type { CronEditor } from './schedule-builder-cron-editor.ts';
  import type { ScheduleIntervalUnit, ScheduleRepeats } from './schedule-builder.types.ts';
  import {
    INTERVAL_UNITS,
    REPEATS_OPTIONS,
    WEEKDAYS,
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
    cronEditors,
    onCronModeChange,
    onCronEditorChange,
    onCronRawChange,
  }: {
    baseId: string;
    draft: ScheduleDraft;
    timeZone: string;
    timeZoneOptions: readonly ComboboxOption[];
    onRepeatsChange: (event: Event) => void;
    onTimeChange: (value: string | undefined) => void;
    onToggleDay: (day: number) => void;
    onDayOfMonthChange: (value: number | null) => void;
    onIntervalCountChange: (value: number | null) => void;
    onIntervalUnitChange: (event: Event) => void;
    onTimeZoneChange: (value: string) => void;
    cronFields: string[];
    cronEditors: CronEditor[];
    onCronModeChange: (index: number, event: Event) => void;
    onCronEditorChange: (index: number, patch: Partial<CronEditor>) => void;
    onCronRawChange: (index: number, value: string) => void;
  } = $props();

  const repeats = $derived<ScheduleRepeats>(draft.repeats);

  // Typing "los angeles" or "los_angeles" both find America/Los_Angeles.
  function filterTimeZone(option: ComboboxOption, query: string): boolean {
    const needle = query.trim().toLowerCase().replaceAll('_', ' ');
    return option.label.toLowerCase().includes(needle);
  }
</script>

<div class="cinder-schedule-builder__field-row">
  <Select
    id={`${baseId}-repeats`}
    label="Repeats"
    options={REPEATS_OPTIONS}
    value={repeats}
    onchange={onRepeatsChange}
  />
  {#if repeats !== 'interval' && repeats !== 'cron'}
    <TimeField id={`${baseId}-at`} label="At" bind:value={() => draft.time, onTimeChange} />
  {/if}
</div>

{#if repeats === 'custom-days'}
  <div class="cinder-schedule-builder__weekday-group" role="group" aria-label="Days of week">
    {#each WEEKDAYS as day (day.value)}
      <Chip
        mode="toggle"
        label={day.short}
        aria-label={day.long}
        pressed={draft.days.includes(day.value)}
        onPressedChange={() => onToggleDay(day.value)}
      />
    {/each}
  </div>
{:else if repeats === 'monthly'}
  <NumberInput
    id={`${baseId}-day-of-month`}
    label="Day of month"
    min={1}
    max={31}
    bind:value={() => draft.dayOfMonth, onDayOfMonthChange}
  />
{:else if repeats === 'interval'}
  <div class="cinder-schedule-builder__field-row">
    <NumberInput
      id={`${baseId}-interval-count`}
      label="Every"
      min={1}
      step={1}
      bind:value={() => draft.intervalCount, onIntervalCountChange}
    />
    <Select
      id={`${baseId}-interval-unit`}
      label="Unit"
      options={intervalUnitOptions}
      value={draft.intervalUnit}
      onchange={onIntervalUnitChange}
    />
  </div>
{:else if repeats === 'cron'}
  <CronEditorFields
    {baseId}
    {cronFields}
    {cronEditors}
    onModeChange={onCronModeChange}
    onEditorChange={onCronEditorChange}
    onRawChange={onCronRawChange}
  />
{/if}

<Combobox
  id={`${baseId}-time-zone`}
  label="Time zone"
  options={timeZoneOptions}
  value={timeZone}
  onValueChange={onTimeZoneChange}
  filter={filterTimeZone}
  {...repeats === 'interval'
    ? {
        description: 'An interval counts from its start, so the zone does not change when it runs.',
      }
    : {}}
/>
