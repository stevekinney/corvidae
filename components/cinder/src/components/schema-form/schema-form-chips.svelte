<!--
  Internal control: a toggle chip for every option of an enum-array field.
  Not part of the public API; SchemaFormBody renders it inside the field's fieldset.
-->
<script lang="ts">
  import Chip from '../chip/chip.svelte';

  import type { SchemaFormOption } from './schema-form-model.ts';

  let {
    options,
    selected,
    disabled = false,
    onValueChange,
  }: {
    /** Every value the array may hold, in schema order. */
    options: SchemaFormOption[];
    /** The array as it stands, which may also hold values that are not options. */
    selected: unknown[];
    disabled?: boolean;
    /** Receives the next array, with the chosen options in schema order. */
    onValueChange: (next: unknown[]) => void;
  } = $props();

  function isPressed(option: SchemaFormOption): boolean {
    return selected.some((value) => Object.is(value, option.value));
  }

  function toggle(option: SchemaFormOption, pressed: boolean): void {
    const chosen = options
      .filter((candidate) => (candidate === option ? pressed : isPressed(candidate)))
      .map((candidate) => candidate.value);
    // Values the schema does not list are not ours to drop; they stay after the chosen options.
    const unlisted = selected.filter(
      (value) => !options.some((candidate) => Object.is(candidate.value, value)),
    );
    onValueChange([...chosen, ...unlisted]);
  }
</script>

<div class="cinder-schema-form__chips">
  {#each options as option (option.encodedValue)}
    <Chip
      mode="toggle"
      label={option.label}
      pressed={isPressed(option)}
      {disabled}
      onPressedChange={(pressed) => toggle(option, pressed)}
    />
  {/each}
</div>
