<script lang="ts" module>
  /**
   * @cinder
   * @category form
   * @status beta
   * @purpose Recurrence control: Repeats, At and Time zone emit a cron or counted interval with its IANA zone, read back with its next runs, with optional overlap and catch-up selects.
   * @tag schedule
   * @tag recurrence
   * @tag cron
   * @tag form
   * @useWhen Letting a user define when a job or notification recurs, supplying your own date/cron library to compute upcoming fire times.
   * @useWhen You want plain repeat choices that still round-trip to a portable cron or interval value, with custom cron one choice away.
   * @avoidWhen You need jitter or backfill-window controls — those belong to the consumer's surrounding form. | invocation-rule-builder
   * @avoidWhen You only need to pick a single point in time, not a recurrence — use date-picker instead. | date-picker
   * @related date-picker, combobox, input, time-field
   * @a11yPattern Form group
   * @a11yNote Repeats is a native select; At is hidden for interval repeats; the time zone is a searchable picker; each custom cron field reports validity via aria-invalid and one associated error.
   */
  export type {
    ScheduleBuilderProps,
    ScheduleBuilderVariant,
    ScheduleFire,
    ScheduleIntervalUnit,
    SchedulePolicyOption,
    ScheduleRepeats,
    ScheduleValue,
  } from './schedule-builder.types.ts';
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  import { classNames } from '../../utilities/class-names.ts';
  import type { ComboboxOption } from '../combobox/combobox.types.ts';
  import Select from '../select/select.svelte';
  import ScheduleBuilderFields from './schedule-builder-fields.svelte';

  import type {
    ScheduleBuilderProps,
    SchedulePolicyOption,
    ScheduleFire,
    ScheduleIntervalUnit,
    ScheduleRepeats,
    ScheduleValue,
  } from './schedule-builder.types.ts';
  import {
    availableTimeZones,
    browserTimeZone,
    cronFieldsValid,
    cronForDraft,
    defaultScheduleValue,
    describeSchedule,
    draftFromValue,
    joinCron,
    orderTimeZones,
    splitCron,
    timeZoneOptionLabel,
    valueFromDraft,
    type ScheduleDraft,
  } from './schedule-builder.utilities.ts';

  const DEFAULT_OVERLAP_OPTIONS: readonly SchedulePolicyOption[] = [
    { value: 'skip', label: 'Skip this one' },
    { value: 'allow', label: 'Start another run' },
  ];

  let {
    value,
    onValueChange,
    computeNextFires,
    previewCount = 5,
    timeZones,
    label = 'Schedule',
    variant = 'default',
    overlap,
    onOverlapChange,
    overlapOptions = DEFAULT_OVERLAP_OPTIONS,
    overlapLabel = 'If a run is still going',
    catchUp,
    onCatchUpChange,
    catchUpLabel = 'If the app was off',
    catchUpOptionLabels = { on: 'Catch up on missed runs', off: 'Don’t catch up on missed runs' },
    class: className,
    'aria-label': ariaLabel,
    'aria-labelledby': ariaLabelledby,
    ...rest
  }: ScheduleBuilderProps = $props();

  const baseId = $props.id();

  const normalizedAriaLabel = $derived(
    typeof ariaLabel === 'string' && ariaLabel.trim().length > 0 ? ariaLabel : undefined,
  );
  const normalizedAriaLabelledby = $derived(
    typeof ariaLabelledby === 'string' && ariaLabelledby.trim().length > 0
      ? ariaLabelledby
      : undefined,
  );
  const resolvedAriaLabel = $derived(
    normalizedAriaLabelledby === undefined && normalizedAriaLabel === undefined
      ? label
      : normalizedAriaLabel,
  );

  function scheduleValuesEqual(a: ScheduleValue, b: ScheduleValue): boolean {
    if (a.timeZone !== b.timeZone) return false;
    if ('cron' in a && 'cron' in b) return a.cron === b.cron;
    if ('every' in a && 'every' in b) {
      return a.every.count === b.every.count && a.every.unit === b.every.unit;
    }
    return false;
  }

  const initialValue = untrack(() => value) ?? defaultScheduleValue();

  const initialDraft = draftFromValue(initialValue);
  const initialCronFields = splitCron(initialDraft.cron);

  let draft = $state<ScheduleDraft>(initialDraft);
  let timeZone = $state(initialValue.timeZone);
  let cronFields = $state<string[]>(initialCronFields);

  // The chosen zone first, then the common ones, then the rest by name; the value's own zone is
  // always offered even when the list leaves it out. The closed field of a compact block shows
  // the zone's name alone, since the row has no room for the city.
  const timeZoneOptions = $derived.by((): ComboboxOption[] => {
    const zones = timeZones === undefined ? availableTimeZones() : [...timeZones];
    if (!zones.includes(timeZone)) zones.unshift(timeZone);
    return orderTimeZones(zones, timeZone).map((zone) => {
      const optionLabel = timeZoneOptionLabel(zone);
      const name = optionLabel.split(' · ')[0] ?? optionLabel;
      return {
        value: zone,
        label: optionLabel,
        ...(variant === 'compact' && name !== optionLabel ? { triggerLabel: name } : {}),
      };
    });
  });

  function seedFrom(next: ScheduleValue): void {
    draft = draftFromValue(next);
    timeZone = next.timeZone;
    cronFields = splitCron(draft.cron);
  }

  const currentValue = $derived(valueFromDraft(draft, timeZone));
  const currentValueIsValid = $derived(draft.repeats !== 'cron' || cronFieldsValid(cronFields));

  type PreviewResult =
    | { status: 'hidden' }
    | { status: 'invalid' }
    | { status: 'error' }
    | { status: 'ok'; fires: ScheduleFire[] };

  const resolvedPreviewCount = $derived(
    Number.isInteger(previewCount) && previewCount > 0 ? previewCount : 5,
  );

  const previewResult = $derived.by((): PreviewResult => {
    if (!computeNextFires) return { status: 'hidden' };
    if (!currentValueIsValid) return { status: 'invalid' };
    try {
      return { status: 'ok', fires: computeNextFires(currentValue, resolvedPreviewCount) };
    } catch {
      return { status: 'error' };
    }
  });

  // What the component shows is the committed value until the first edit: the controlled value
  // when there is one, otherwise the default every day at 9:00 AM in the browser's zone.
  let lastKnownValue: ScheduleValue = initialValue;

  function initialValueProp(): ScheduleValue | undefined {
    return value;
  }

  let previousValueProp: ScheduleValue | undefined = initialValueProp();

  $effect(() => {
    const incoming = value;
    const propChanged = incoming !== previousValueProp;
    previousValueProp = incoming;
    if (!propChanged) return;

    // Undefined explicitly resets; defined equal values are controlled echoes.
    if (incoming !== undefined && scheduleValuesEqual(incoming, lastKnownValue)) return;
    const next = incoming ?? defaultScheduleValue(browserTimeZone());
    seedFrom(next);
    lastKnownValue = next;
  });

  function emitChange(): void {
    if (!currentValueIsValid) return;
    lastKnownValue = currentValue;
    onValueChange?.(currentValue);
  }

  const fixedDays: Partial<Record<ScheduleRepeats, number[]>> = {
    daily: [0, 1, 2, 3, 4, 5, 6],
    weekdays: [1, 2, 3, 4, 5],
    weekends: [0, 6],
  };

  function handleRepeatsChange(event: Event): void {
    const nextRepeats = (event.currentTarget as HTMLSelectElement).value as ScheduleRepeats;
    if (nextRepeats === draft.repeats) return;
    const previous = draft;
    // Custom days starts from the days the previous choice ran on, and Custom cron from the
    // expression it lowered to, so neither choice starts from nothing.
    const days = fixedDays[previous.repeats] ?? previous.days;
    const cron = previous.repeats === 'interval' ? previous.cron : cronForDraft(previous);
    draft = { ...previous, repeats: nextRepeats, days: [...days], cron };
    if (nextRepeats === 'cron') cronFields = splitCron(cron);
    emitChange();
  }

  function handleTimeChange(next: string | undefined): void {
    if (!next) return;
    draft = { ...draft, time: next };
    emitChange();
  }

  function toggleDay(day: number): void {
    const selected = draft.days.includes(day);
    // Custom days always runs on at least one day.
    if (selected && draft.days.length === 1) return;
    draft = {
      ...draft,
      days: selected ? draft.days.filter((existing) => existing !== day) : [...draft.days, day],
    };
    emitChange();
  }

  function handleDayOfMonthChange(next: number | null): void {
    draft = { ...draft, dayOfMonth: next && next >= 1 ? Math.min(31, Math.trunc(next)) : 1 };
    emitChange();
  }

  function toPositiveInteger(next: number | null): number {
    if (next === null || !Number.isFinite(next) || next < 1) return 1;
    return Math.trunc(next);
  }

  function handleIntervalCountChange(next: number | null): void {
    draft = { ...draft, intervalCount: toPositiveInteger(next) };
    emitChange();
  }

  function handleIntervalUnitChange(event: Event): void {
    const unit = (event.currentTarget as HTMLSelectElement).value as ScheduleIntervalUnit;
    draft = { ...draft, intervalUnit: unit };
    emitChange();
  }

  function handleTimeZoneChange(next: string): void {
    if (next === '' || next === timeZone) return;
    timeZone = next;
    emitChange();
  }

  function commitCronFields(next: string[]): void {
    cronFields = next;
    draft = { ...draft, cron: joinCron(next) };
    emitChange();
  }

  function handleCronFieldChange(index: number, raw: string): void {
    const next = [...cronFields];
    next[index] = raw;
    commitCronFields(next);
  }

  function handleOverlapChange(event: Event): void {
    onOverlapChange?.((event.currentTarget as HTMLSelectElement).value);
  }

  function handleCatchUpChange(event: Event): void {
    onCatchUpChange?.((event.currentTarget as HTMLSelectElement).value === 'on');
  }

  const catchUpOptions = $derived([
    { value: 'on', label: catchUpOptionLabels.on },
    { value: 'off', label: catchUpOptionLabels.off },
  ]);
  const showPolicies = $derived(overlap !== undefined || catchUp !== undefined);
  const compact = $derived(variant === 'compact');
  const isInterval = $derived(draft.repeats === 'interval');
  // An interval's preview counts from creation, not from a clock.
  const nextRunsLabel = $derived(
    isInterval ? 'Next runs · counting from when you create it' : 'Next runs',
  );
</script>

{#snippet policies()}
  {#if showPolicies}
    <div class="cinder-schedule-builder__policies">
      {#if overlap !== undefined}
        <Select
          id={`${baseId}-overlap`}
          label={overlapLabel}
          options={overlapOptions}
          value={overlap}
          onchange={handleOverlapChange}
        />
      {/if}
      {#if catchUp !== undefined}
        <Select
          id={`${baseId}-catch-up`}
          label={catchUpLabel}
          options={catchUpOptions}
          value={catchUp ? 'on' : 'off'}
          onchange={handleCatchUpChange}
        />
      {/if}
    </div>
  {/if}
{/snippet}

{#snippet nextRuns()}
  {#if previewResult.status === 'invalid'}
    <p class="cinder-schedule-builder__empty">No preview until the cron expression is valid.</p>
  {:else if previewResult.status !== 'hidden'}
    <div class="cinder-schedule-builder__preview">
      <span class="cinder-schedule-builder__section-label" id={`${baseId}-preview-label`}>
        {nextRunsLabel}
      </span>
      {#if previewResult.status === 'error'}
        <p class="cinder-schedule-builder__empty">Preview unavailable.</p>
      {:else if previewResult.fires.length > 0}
        <ul
          class="cinder-schedule-builder__preview-list"
          aria-labelledby={`${baseId}-preview-label`}
        >
          {#each previewResult.fires as fire (fire.id)}
            <li class="cinder-schedule-builder__preview-item">{fire.label}</li>
          {/each}
        </ul>
      {:else}
        <p class="cinder-schedule-builder__empty">No upcoming runs.</p>
      {/if}
    </div>
  {/if}
{/snippet}

<div
  {...rest}
  class={classNames('cinder-schedule-builder', className)}
  role="group"
  aria-label={resolvedAriaLabel}
  aria-labelledby={normalizedAriaLabelledby}
  data-sb-repeats={draft.repeats}
  data-cinder-variant={variant}
>
  <ScheduleBuilderFields
    {baseId}
    {variant}
    {draft}
    {timeZone}
    {timeZoneOptions}
    onRepeatsChange={handleRepeatsChange}
    onTimeChange={handleTimeChange}
    onToggleDay={toggleDay}
    onDayOfMonthChange={handleDayOfMonthChange}
    onIntervalCountChange={handleIntervalCountChange}
    onIntervalUnitChange={handleIntervalUnitChange}
    onTimeZoneChange={handleTimeZoneChange}
    {cronFields}
    onCronFieldChange={handleCronFieldChange}
  />

  {#if compact}
    {@render policies()}
    {@render nextRuns()}
  {:else}
    <div class="cinder-schedule-builder__panel">
      <span class="cinder-schedule-builder__section-label" id={`${baseId}-runs-label`}>Runs</span>
      {#if currentValueIsValid}
        <p class="cinder-schedule-builder__summary-text" aria-live="polite">
          {describeSchedule(currentValue)}.
        </p>
        {@render nextRuns()}
      {:else}
        <p class="cinder-schedule-builder__empty" aria-live="polite">
          No preview until the cron expression is valid.
        </p>
      {/if}
    </div>
    {@render policies()}
  {/if}
</div>
