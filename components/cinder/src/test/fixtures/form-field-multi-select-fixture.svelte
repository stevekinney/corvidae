<script lang="ts" module>
  import type { MultiSelectItem } from '@lostgradient/multi-select/components/multi-select/multi-select.types.ts';

  export type FormFieldMultiSelectFixtureProps = {
    fieldId: string;
    fieldLabel: string;
    items: ReadonlyArray<MultiSelectItem<string>>;
    selectedIds?: string[];
    fieldWarning?: string;
    warning?: string;
  };
</script>

<script lang="ts">
  import FormField from '@lostgradient/form-field/components/form-field/form-field.svelte';
  import MultiSelect from '@lostgradient/multi-select/components/multi-select/multi-select.svelte';

  let {
    fieldId,
    fieldLabel,
    items,
    selectedIds = [],
    fieldWarning,
    warning,
  }: FormFieldMultiSelectFixtureProps = $props();

  const optionalMultiSelectProps = $derived(warning === undefined ? {} : { warning });
</script>

<FormField id={fieldId} label={fieldLabel} warning={fieldWarning}>
  <MultiSelect id={fieldId} {items} bind:selectedIds {...optionalMultiSelectProps} />
</FormField>
