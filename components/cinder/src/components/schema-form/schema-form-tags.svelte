<!--
  Internal control: a labelled tag input for a string-array field.
  Not part of the public API; SchemaFormBody renders it for `tags` fields.
-->
<script lang="ts">
  import { onMount, untrack } from 'svelte';

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
    draft = '',
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
    /** Text typed earlier and not yet committed, put back when the control is mounted again. */
    draft?: string;
    /** True when the schema does not require unique items. */
    duplicateValuesAllowed: boolean;
    onValueChange: (next: string[]) => void;
    onblur?: () => void;
  } = $props();

  // The tag input holds its pending text privately and loses it when it unmounts, so a control
  // that comes back (a cleared filter, a reopened group) gets that text typed back in.
  onMount(() => {
    const pending = untrack(() => draft);
    if (pending === '') return;
    const input = document.getElementById(id);
    if (!(input instanceof HTMLInputElement)) return;
    input.value = pending;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
</script>

<FormField {id} {label} {description} {error} {required} {disabled}>
  <TagInput {value} {duplicateValuesAllowed} commitOnSubmit {disabled} {onValueChange} {onblur} />
</FormField>
