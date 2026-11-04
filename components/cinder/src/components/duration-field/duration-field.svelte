<script lang="ts" module>
  /**
   * @cinder
   * @category form
   * @status beta
   * @purpose Number plus unit for a duration that is stored in milliseconds, so a person types 30 and picks seconds while the value stays one number.
   * @tag form
   * @tag duration
   * @tag numeric
   * @useWhen A setting or schema field holds a length of time in milliseconds and the person should not have to count zeros.
   * @useWhen A setting always counts in one unit and should show it beside the number ("30 seconds") — set `unitSelectable` to `false`.
   * @avoidWhen Collecting a clock time or a calendar date — use time-field or date-picker.
   * @avoidWhen Showing a duration read-only — format it with `formatDuration`.
   * @related number-input, select, time-field
   */
  export type { DurationFieldProps } from './duration-field.types.ts';
  export type { DurationUnit } from './duration-units.ts';
</script>

<script lang="ts">
  import type { FormFieldContext } from '../../_internal/form-field-context.ts';
  import FormFieldProvider from '../../_internal/form-field-provider.svelte';
  import { classNames } from '../../utilities/class-names.ts';
  import NumberInput from '../number-input/number-input.svelte';
  import Select from '../select/select.svelte';
  import type { DurationFieldProps } from './duration-field.types.ts';
  import {
    DURATION_UNITS,
    durationUnitFor,
    fromMilliseconds,
    toMilliseconds,
  } from './duration-units.ts';

  let {
    id,
    value = $bindable(null),
    onValueChange,
    label,
    description,
    error,
    required = false,
    disabled = false,
    name,
    integer = false,
    units = DURATION_UNITS,
    unit = $bindable(),
    unitSelectable = true,
    onblur,
    class: className,
  }: DurationFieldProps = $props();

  // The unit is how the number is shown, not part of the value, so it lives and dies with the
  // control. It starts as the largest unit that shows the stored value as a whole number.
  // svelte-ignore state_referenced_locally
  let shownUnit = $state(unit ?? durationUnitFor(value, units));

  // The last value this control sent up. A `value` that differs from it was replaced from outside
  // (Edit as JSON), so the unit is chosen again for it; a `value` that matches is our own edit
  // coming back, which must keep the unit the person picked.
  // svelte-ignore state_referenced_locally
  let lastSent: number | null | undefined = value;

  $effect.pre(() => {
    if (value === lastSent) return;
    lastSent = value;
    shownUnit = durationUnitFor(value, units);
    unit = shownUnit;
  });

  $effect.pre(() => {
    if (unit !== undefined && unit !== shownUnit) shownUnit = unit;
  });

  const activeUnit = $derived(units.find((candidate) => candidate.value === shownUnit) ?? units[0]);
  const shown = $derived(
    value === undefined || value === null ? null : fromMilliseconds(value, shownUnit, units),
  );

  // Inside a FormField or SettingRow the select must not read the outer field's id and error, so
  // it gets a context of its own.
  const unitContext: FormFieldContext = {
    get controlId() {
      return `${id}-unit`;
    },
    labelId: undefined,
    describedBy: undefined,
    descriptionId: undefined,
    warningId: undefined,
    managedId: undefined,
    errorId: undefined,
    invalid: undefined,
    required: false,
    get disabled() {
      return disabled;
    },
  };
</script>

<div
  class={classNames('cinder-duration-field', className)}
  data-cinder-fixed-unit={unitSelectable ? undefined : ''}
>
  <NumberInput
    {id}
    {...label !== undefined ? { label } : {}}
    {...description !== undefined ? { description } : {}}
    {...error !== undefined ? { error } : {}}
    {...name !== undefined ? { name } : {}}
    {...onblur !== undefined ? { onblur } : {}}
    {...unitSelectable ? {} : { adornment: activeUnit?.name ?? activeUnit?.label ?? '' }}
    {required}
    {disabled}
    value={shown}
    onValueChange={(next) => {
      const milliseconds = next === null ? null : toMilliseconds(next, shownUnit, integer, units);
      lastSent = milliseconds;
      value = milliseconds;
      onValueChange?.(milliseconds);
    }}
  />
  {#if unitSelectable}
    <FormFieldProvider context={unitContext}>
      <Select
        id={`${id}-unit`}
        label={label ? `${label} unit` : 'Unit'}
        labelVisible={false}
        {disabled}
        options={units.map((candidate) => ({ value: candidate.value, label: candidate.label }))}
        value={shownUnit}
        onchange={(event) => {
          shownUnit = event.currentTarget.value;
          unit = shownUnit;
        }}
      />
    </FormFieldProvider>
  {/if}
</div>
