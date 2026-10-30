<!--
  Internal control: a number plus a unit for a duration that the schema stores in milliseconds.
  Not part of the public API; SchemaFormBody renders it for fields whose `unit` is milliseconds.
-->
<script lang="ts">
  import NumberInput from '../number-input/number-input.svelte';
  import Select from '../select/select.svelte';

  import {
    DURATION_UNITS,
    durationUnitFor,
    fromMilliseconds,
    toMilliseconds,
  } from './schema-form-duration.ts';

  let {
    id,
    label,
    description,
    error,
    required = false,
    disabled = false,
    integer,
    value,
    onValueChange,
    onblur,
  }: {
    id: string;
    label: string;
    description?: string | undefined;
    error?: string | undefined;
    required?: boolean;
    disabled?: boolean;
    /** True for an `integer` schema: the stored milliseconds are rounded to whole numbers. */
    integer: boolean;
    /** The stored value, in milliseconds. */
    value: number | undefined;
    /** Receives the next value in milliseconds, or `null` when the number is cleared or unparseable. */
    onValueChange: (next: number | null) => void;
    onblur?: () => void;
  } = $props();

  // The unit is how the number is shown, not part of the value, so it lives and dies with the
  // control. It starts as the largest unit that shows the stored value as a whole number.
  // svelte-ignore state_referenced_locally
  let unit = $state(durationUnitFor(value));

  // The last value this control sent up. A `value` that differs from it was replaced from outside
  // (Edit as JSON), so the unit is chosen again for it; a `value` that matches is our own edit
  // coming back, which must keep the unit the person picked.
  // svelte-ignore state_referenced_locally
  let lastSent: number | undefined = value;

  $effect.pre(() => {
    if (value === lastSent) return;
    lastSent = value;
    unit = durationUnitFor(value);
  });

  const shown = $derived(value === undefined ? null : fromMilliseconds(value, unit));
</script>

<div class="cinder-schema-form__duration">
  <NumberInput
    {id}
    {label}
    {...description !== undefined ? { description } : {}}
    {...error !== undefined ? { error } : {}}
    {...onblur !== undefined ? { onblur } : {}}
    {required}
    {disabled}
    value={shown}
    onValueChange={(next) => {
      const milliseconds = next === null ? null : toMilliseconds(next, unit, integer);
      lastSent = milliseconds ?? undefined;
      onValueChange(milliseconds);
    }}
  />
  <Select
    id={`${id}-unit`}
    label={`${label} unit`}
    labelVisible={false}
    {disabled}
    options={DURATION_UNITS.map((candidate) => ({
      value: candidate.value,
      label: candidate.label,
    }))}
    value={unit}
    onchange={(event) => {
      unit = event.currentTarget.value;
    }}
  />
</div>
