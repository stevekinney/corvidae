<script lang="ts">
  /*
   * The numeric field of a foundation editor (COR-489): dimension, duration, number and font
   * weight. The text stays exactly as typed, so partial input is visible while it is invalid;
   * a unit select sits beside it for dimensions and durations, and a slider (opacity, font
   * weight, unitless line height) always has this numeric field as its equivalent. One slider
   * gesture is one history transaction: the editor opens it on the first pointer or key press
   * and closes it on release.
   */
  import { Input, Select, Slider } from '@lostgradient/cinder';

  import type { CatalogueRow } from './theme-builder-catalogue.ts';
  import {
    parseNumberText,
    profileHint,
    sliderSpecFor,
    UNITS,
    type FieldErrors,
    type FoundationFields,
  } from './theme-foundation-values.ts';

  type Scalar = Extract<FoundationFields, { amount: string }>;

  type Props = {
    row: CatalogueRow;
    fields: Scalar;
    errors: FieldErrors;
    idBase: string;
    label: (part: string) => string;
    disabled: boolean;
    onchange: (next: Scalar) => void;
    onslide: (amount: string) => void;
    ongesture: { begin: () => void; end: () => void };
    onenter: () => void;
  };
  let {
    row,
    fields,
    errors,
    idBase,
    label,
    disabled,
    onchange,
    onslide,
    ongesture,
    onenter,
  }: Props = $props();

  const slider = $derived(sliderSpecFor(row));
  const numeric = $derived(parseNumberText(fields.amount));
  const hint = $derived(profileHint(row.profile));
  const units = $derived.by(() => {
    if (fields.kind !== 'dimension' && fields.kind !== 'duration') return null;
    const known = UNITS[fields.kind];
    return known.includes(fields.unit) ? known : [...known, fields.unit];
  });
  const description = $derived(
    fields.kind === 'dimension'
      ? `Changing the unit keeps the number. ${hint}`.trim()
      : fields.kind === 'fontWeight'
        ? `A number from 1 to 1000 or a DTCG name such as bold. ${hint}`.trim()
        : hint,
  );

  function keydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      onenter();
    }
  }
</script>

<svelte:window onpointerup={ongesture.end} onpointercancel={ongesture.end} />

<div class="scalar">
  <div class="scalar__inputs" onkeydown={keydown} role="presentation">
    <Input
      id={`${idBase}-amount`}
      label={label(fields.kind === 'fontWeight' ? 'weight' : 'value')}
      inputmode="decimal"
      autocomplete="off"
      spellcheck={false}
      {disabled}
      {...description === '' ? {} : { description }}
      {...errors['amount'] === undefined ? {} : { error: errors['amount'] }}
      value={fields.amount}
      onValueChange={(amount) => onchange({ ...fields, amount })}
    />
    {#if units !== null && (fields.kind === 'dimension' || fields.kind === 'duration')}
      <Select
        id={`${idBase}-unit`}
        label={label('unit')}
        options={units.map((unit) => ({ value: unit, label: unit }))}
        value={fields.unit}
        {disabled}
        {...errors['unit'] === undefined ? {} : { error: errors['unit'] }}
        onchange={(event) => onchange({ ...fields, unit: event.currentTarget.value })}
      />
    {/if}
  </div>
  {#if slider !== null && numeric !== undefined}
    <div
      class="scalar__slider"
      role="presentation"
      onpointerdowncapture={ongesture.begin}
      onkeydowncapture={ongesture.begin}
      onkeyup={ongesture.end}
      onfocusout={ongesture.end}
    >
      <Slider
        label={label('slider')}
        min={slider.min}
        max={slider.max}
        step={slider.step}
        value={Math.min(slider.max, Math.max(slider.min, numeric))}
        {disabled}
        onValueChange={(next) => onslide(String(next))}
      />
    </div>
  {/if}
</div>

<style>
  .scalar,
  .scalar__inputs {
    display: grid;
    gap: 8px;
    min-width: 0;
  }
  @media (min-width: 480px) {
    .scalar__inputs {
      grid-template-columns: minmax(0, 1fr) minmax(5rem, 7rem);
      align-items: start;
    }
  }
</style>
