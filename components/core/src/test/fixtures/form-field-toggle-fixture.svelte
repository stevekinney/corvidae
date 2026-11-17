<script lang="ts">
  import FormField from '../../components/form-field/form-field.svelte';
  import Toggle from '../../components/toggle/toggle.svelte';

  let {
    fieldId,
    fieldLabel,
    disabled = false,
    toggleLabel = 'Toggle',
    standalone = false,
    labelPosition = 'end',
  }: {
    fieldId: string;
    fieldLabel?: string;
    /** Disabled on the FormField — Toggle should inherit it from context. */
    disabled?: boolean;
    toggleLabel?: string;
    /** Passed to the Toggle: it is its own field inside the FormField. */
    standalone?: boolean;
    labelPosition?: 'start' | 'end';
  } = $props();

  const fieldOptional = $derived(disabled ? { disabled: true } : {});
</script>

<FormField id={fieldId} label={fieldLabel} {...fieldOptional}>
  <!-- A standalone switch is a second control in the field, so it has an id of its own. -->
  <Toggle
    id={standalone ? `${fieldId}-switch` : fieldId}
    label={toggleLabel}
    {standalone}
    {labelPosition}
  />
</FormField>
