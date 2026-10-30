<script lang="ts" module>
  /**
   * @cinder
   * @category form
   * @status beta
   * @purpose Recurrence-definition control that reads a schedule as Repeats, At and Time zone, emits a cron or a counted interval with its IANA zone, and reads the schedule back as a sentence with its next runs.
   * @tag schedule
   * @tag recurrence
   * @tag cron
   * @tag form
   * @useWhen Letting a user define when a job or notification recurs, supplying your own date/cron library to compute upcoming fire times.
   * @useWhen You want plain repeat choices that still round-trip to a portable cron or interval value, with custom cron one choice away.
   * @avoidWhen You need overlap policy, jitter, or backfill controls — those belong to the consumer's surrounding form. | invocation-rule-builder
   * @avoidWhen You only need to pick a single point in time, not a recurrence — use date-picker instead. | date-picker
   * @related date-picker, combobox, input, time-field
   * @a11yPattern Form group
   * @a11yNote Repeats is a native select; At is hidden for interval repeats; the time zone is a searchable combobox; each custom cron field reports validity via aria-invalid and an associated hint or error.
   */
  export type {
    ScheduleBuilderProps,
    ScheduleFire,
    ScheduleIntervalUnit,
    ScheduleRepeats,
    ScheduleValue,
  } from './schedule-builder.types.ts';
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  import { classNames } from '../../utilities/class-names.ts';
  import type { ComboboxOption } from '../combobox/combobox.types.ts';
  import ScheduleBuilderFields from './schedule-builder-fields.svelte';

  import type {
    ScheduleBuilderProps,
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
    splitCron,
    valueFromDraft,
    type ScheduleDraft,
  } from './schedule-builder.utilities.ts';
  import {
    cronExpressionForEditor,
    editorFromCronField,
    type CronEditor,
    type CronEditorMode,
  } from './schedule-builder-cron-editor.ts';

  let {
    value,
    onValueChange,
    computeNextFires,
    previewCount = 5,
    timeZones,
    label = 'Schedule',
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
  let cronEditors = $state<CronEditor[]>(initialCronFields.map(editorFromCronField));

  // Grouped by region, with the value's own zone always offered even when the list leaves it out.
  const timeZoneOptions = $derived.by((): ComboboxOption[] => {
    const zones = timeZones === undefined ? availableTimeZones() : [...timeZones];
    if (!zones.includes(timeZone)) zones.unshift(timeZone);
    return zones.map((zone) => {
      const slash = zone.indexOf('/');
      return {
        value: zone,
        label: zone.replaceAll('_', ' '),
        group: slash === -1 ? 'Other' : zone.slice(0, slash),
      };
    });
  });

  function seedFrom(next: ScheduleValue): void {
    draft = draftFromValue(next);
    timeZone = next.timeZone;
    cronFields = splitCron(draft.cron);
    cronEditors = cronFields.map(editorFromCronField);
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
    if (nextRepeats === 'cron') {
      cronFields = splitCron(cron);
      cronEditors = cronFields.map(editorFromCronField);
    }
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
    const nextEditors = [...cronEditors];
    nextEditors[index] = { ...editorFromCronField(raw, index), mode: 'advanced' };
    cronEditors = nextEditors;
    commitCronFields(next);
  }

  function handleCronEditorModeChange(index: number, event: Event): void {
    const mode = (event.currentTarget as HTMLSelectElement).value as CronEditorMode;
    const next = [...cronEditors];
    next[index] = { ...next[index]!, mode };
    cronEditors = next;
    if (mode !== 'advanced') handleCronEditorChange(index);
  }

  function handleCronEditorChange(index: number): void {
    const editor = cronEditors[index];
    if (!editor || editor.mode === 'advanced') return;
    const next = [...cronFields];
    next[index] = cronExpressionForEditor(editor);
    commitCronFields(next);
  }

  function updateCronEditor(index: number, patch: Partial<CronEditor>): void {
    const next = [...cronEditors];
    next[index] = { ...next[index]!, ...patch };
    cronEditors = next;
    handleCronEditorChange(index);
  }
</script>

<div
  {...rest}
  class={classNames('cinder-schedule-builder', className)}
  role="group"
  aria-label={resolvedAriaLabel}
  aria-labelledby={normalizedAriaLabelledby}
  data-sb-repeats={draft.repeats}
>
  <ScheduleBuilderFields
    {baseId}
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
    {cronEditors}
    onCronModeChange={handleCronEditorModeChange}
    onCronEditorChange={updateCronEditor}
    onCronRawChange={handleCronFieldChange}
  />

  <dl class="cinder-schedule-builder__summary">
    <dt class="cinder-schedule-builder__section-label">Runs</dt>
    <dd class="cinder-schedule-builder__summary-text" aria-live="polite">
      {currentValueIsValid ? describeSchedule(currentValue) : 'Fix the cron expression above.'}
    </dd>
  </dl>

  {#if previewResult.status !== 'hidden'}
    <div class="cinder-schedule-builder__preview">
      <span class="cinder-schedule-builder__section-label" id={`${baseId}-preview-label`}>
        Next runs
      </span>
      {#if previewResult.status === 'invalid'}
        <p class="cinder-schedule-builder__empty">
          Preview unavailable — fix the cron expression above.
        </p>
      {:else if previewResult.status === 'error'}
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
</div>
