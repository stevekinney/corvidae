<!--
  Internal control: a labelled tag input for a string-array field.
  Not part of the public API; SchemaFormBody renders it for `tags` fields.
-->
<script lang="ts">
  import FormField from '../form-field/form-field.svelte';
  import TagInput from '../tag-input/tag-input.svelte';

  let {
    id,
    label,
    description,
    error,
    required = false,
    disabled = false,
    value,
    duplicateValuesAllowed,
    onValueChange,
    onblur,
  }: {
    id: string;
    label: string;
    description?: string | undefined;
    error?: string | undefined;
    required?: boolean;
    disabled?: boolean;
    value: string[];
    /** True when the schema does not require unique items. */
    duplicateValuesAllowed: boolean;
    onValueChange: (next: string[]) => void;
    onblur?: () => void;
  } = $props();
</script>

<FormField {id} {label} {description} {error} {required} {disabled}>
  <TagInput {value} {duplicateValuesAllowed} commitOnSubmit {disabled} {onValueChange} {onblur} />
</FormField>
