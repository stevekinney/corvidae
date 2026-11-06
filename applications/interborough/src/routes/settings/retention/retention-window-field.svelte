<script lang="ts">
  /**
   * The control of a retention row (board PageSettingsSections, "Data and retention"): a choice
   * between Keep forever and Delete after, and, once it is Delete after, the days in a field. The
   * row saves when the choice changes to Keep forever, and when focus leaves the control with a
   * number of days in it. Choosing Delete after only opens the field, so a click never starts
   * deleting records: nothing is saved until the person has typed a number of days.
   *
   * The draft is the Bureau's own value: `'forever'` or `{ olderThan }` in milliseconds, or, for
   * a window with no `'forever'` (`retention.memory`), nothing at all for Keep forever.
   */
  import { NumberInput, Segment, SegmentedControl } from '@lostgradient/cinder';

  import { DATA_RETENTION_COPY } from '../../../app/copy.ts';
  import {
    retentionChoiceOf,
    retentionDaysOf,
    retentionWindowOfDays,
    type RetentionChoice,
  } from './retention-window.ts';

  interface Props {
    /** The row's element id, which its label points at: the days field takes it, and the choice's is derived from it. */
    id: string;
    /** The row's name, which the choice and the field are named for. */
    name: string;
    /** The window the row holds now. */
    value: unknown;
    /** What Keep forever stores: `'forever'`, or nothing for a window the Bureau has no `'forever'` for. */
    forever: 'forever' | undefined;
    /**
     * Whether Keep forever is offered. A window whose unset value is a finite default has no way to
     * keep for ever, so its row offers only Delete after.
     */
    keepForeverOffered?: boolean;
    /** Whether the controls cannot be changed, such as when the deployment locked the setting. */
    disabled?: boolean;
    /** Whether the value is one the row will not save, which marks the days field. */
    invalid?: boolean;
    /** Called with the window the person chose or typed. */
    onChange: (next: unknown) => void;
    /** Called when the value is ready to save. */
    onLeave: () => void;
  }

  let {
    id,
    name,
    value,
    forever,
    keepForeverOffered = true,
    disabled = false,
    invalid = false,
    onChange,
    onLeave,
  }: Props = $props();

  /** Delete after was chosen but no number of days has been typed yet. */
  let pendingAfter = $state(false);
  /** What the days field holds while it is being typed in; `undefined` when it follows the value. */
  let typing = $state<number | null | undefined>(undefined);
  let field = $state<HTMLElement | undefined>(undefined);

  const choice = $derived<RetentionChoice>(
    !keepForeverOffered || pendingAfter ? 'after' : retentionChoiceOf(value),
  );
  const shown = $derived(typing !== undefined ? typing : (retentionDaysOf(value) ?? null));

  function choose(next: string): void {
    if (next === 'forever') {
      pendingAfter = false;
      typing = undefined;
      onChange(forever);
      onLeave();
      return;
    }
    if (retentionChoiceOf(value) === 'after') return;
    pendingAfter = true;
    // The field opens empty: focus goes to it, so the number is the next thing typed.
    queueMicrotask(() => field?.querySelector('input')?.focus());
  }

  function type(next: number | null): void {
    typing = next;
    // A cleared field is not a window yet: the value stays, and the field is put back when it is left.
    if (next === null) return;
    pendingAfter = false;
    onChange(retentionWindowOfDays(next));
  }

  /** Saves when focus leaves the whole control, not when it moves between its two parts. */
  function leaveControl(event: FocusEvent): void {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget instanceof Node) {
      if (event.currentTarget.contains(next)) return;
    }
    typing = undefined;
    // A choice of Delete after with no days typed is abandoned: the row is as it was.
    if (retentionChoiceOf(value) !== 'after') pendingAfter = false;
    onLeave();
  }
</script>

<div class="ib-retention-field" onfocusout={leaveControl} data-choice={choice}>
  <SegmentedControl
    id={`${id}-choice`}
    label={DATA_RETENTION_COPY.retention.choiceLabel(name)}
    labelVisible={false}
    value={choice}
    {disabled}
    onValueChange={choose}
  >
    {#if keepForeverOffered}
      <Segment value="forever">{DATA_RETENTION_COPY.retention.keepForever}</Segment>
    {/if}
    <Segment value="after">{DATA_RETENTION_COPY.retention.deleteAfter}</Segment>
  </SegmentedControl>
  {#if choice === 'after'}
    <div class="ib-retention-field__days" bind:this={field}>
      <NumberInput
        {id}
        aria-label={DATA_RETENTION_COPY.retention.daysLabel(name)}
        value={shown}
        {disabled}
        aria-invalid={invalid}
        adornment={DATA_RETENTION_COPY.retention.days}
        onValueChange={type}
      />
    </div>
  {/if}
</div>

<style>
  .ib-retention-field {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
    align-items: center;
    justify-content: flex-end;
  }

  .ib-retention-field__days {
    /* Wide enough for the longest value the field accepts, or one it refuses (9,999), beside the unit and the stepper. */
    inline-size: 12rem;
  }
</style>
