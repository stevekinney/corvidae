<script lang="ts">
  /**
   * The When block shared by the pages that make a schedule: the new schedule page and the run
   * setup page. It is Cinder's `ScheduleBuilder` (Repeats, At, Time zone, the schedule read back as
   * a sentence, and the next runs in the chosen zone) in a region the page can ask about. A page
   * that also asks the two policy selects ("If a run is still going", "If Interborough was off")
   * passes their values, and the builder draws them under the preview.
   *
   * The builder keeps the last cadence it emitted while a custom field is out of range, so the
   * value the page holds is not the one on screen. A page asks `isInvalid` before it saves and
   * refuses while it says so, which is the one place that rule lives. `onProblem` is told, as a
   * person edits, the label of the first field that shows a problem (or `undefined` when none
   * does), so the page can say what Create will do about it; `focusProblem` moves focus to that
   * field.
   */
  import {
    ScheduleBuilder,
    type SchedulePolicyOption,
    type ScheduleValue,
  } from '@lostgradient/cinder';

  import { computeNextFires } from '../../lib/format/cron-preview.ts';
  import { shownCadenceIsInvalid } from './cadence.ts';

  interface Props {
    /** The cadence the builder opens with, and shows. */
    value: ScheduleValue;
    /** Takes each valid cadence the builder commits. */
    onValueChange: (next: ScheduleValue) => void;
    /** The label of the builder. */
    label: string;
    /** The chosen overlap policy; the select is drawn only when this is set. */
    overlap?: string | undefined;
    /** Takes the overlap policy the person picks. */
    onOverlapChange?: ((next: string) => void) | undefined;
    /** The choices of the overlap select; the builder's own (skip, allow) when unset. */
    overlapOptions?: readonly SchedulePolicyOption[] | undefined;
    /** Whether to catch up on the fires missed while the host was down; the select is drawn only when this is set. */
    catchUp?: boolean | undefined;
    /** Takes the catch-up choice the person makes. */
    onCatchUpChange?: ((next: boolean) => void) | undefined;
    /** The label of the catch-up select. */
    catchUpLabel?: string | undefined;
    /** Told the label of the first field that shows a problem, or `undefined` when none does. */
    onProblem?: ((field: string | undefined) => void) | undefined;
  }

  let {
    value,
    onValueChange,
    label,
    overlap,
    onOverlapChange,
    overlapOptions,
    catchUp,
    onCatchUpChange,
    catchUpLabel,
    onProblem,
  }: Props = $props();

  let region = $state<HTMLElement>();

  /** Whether a field the builder shows is out of range, so that the cadence a page holds is not the one on screen. */
  export function isInvalid(): boolean {
    return shownCadenceIsInvalid(region);
  }

  /** The field that shows a problem, first in the order of the page. */
  function problemElement(): HTMLElement | undefined {
    return region?.querySelector<HTMLElement>('[aria-invalid="true"]') ?? undefined;
  }

  /** Moves focus to the first field that shows a problem; `false` when none does. */
  export function focusProblem(): boolean {
    const field = problemElement();
    field?.focus();
    return field !== undefined;
  }

  /** The label of a control, as the person reads it. */
  function labelOf(control: HTMLElement): string | undefined {
    const labelled = control.getAttribute('aria-labelledby');
    const text = labelled === null ? undefined : document.getElementById(labelled)?.textContent;
    const own = text ?? control.closest('.cinder-form-field')?.querySelector('label')?.textContent;
    const trimmed = own?.replace(/\s+/g, ' ').trim();
    return trimmed === undefined || trimmed === '' ? undefined : trimmed;
  }

  let reported: string | undefined = undefined;
  /** Reports the problem the builder shows now, once its own handlers have settled. */
  function report(): void {
    if (onProblem === undefined) return;
    queueMicrotask(() => {
      const control = problemElement();
      const field = control === undefined ? undefined : (labelOf(control) ?? 'the repeat');
      if (field === reported) return;
      reported = field;
      onProblem(field);
    });
  }
</script>

<div
  class="ib-schedule-when"
  bind:this={region}
  data-testid="schedule-when"
  oninput={report}
  onchange={report}
  onfocusout={report}
>
  <ScheduleBuilder
    {value}
    {onValueChange}
    {computeNextFires}
    previewCount={3}
    {label}
    {overlap}
    {onOverlapChange}
    {overlapOptions}
    {catchUp}
    {onCatchUpChange}
    {catchUpLabel}
  />
</div>

<style>
  .ib-schedule-when {
    min-width: 0;
  }
</style>
