<!--
  Internal component: a setting row that carries a group's words (its title and description) around
  one field's control. The row's own label names the group, so the control is named by the field's
  own label, drawn only for assistive technology, and keeps the row's description and error.

  This component is NOT part of the public API. Import SchemaForm instead.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  import { getFormFieldContext } from '../../_internal/form-field-context.ts';
  import type { FormFieldContext } from '../../_internal/form-field-context.ts';
  import FormFieldProvider from '../../_internal/form-field-provider.svelte';

  let {
    id,
    label,
    named = true,
    children,
  }: {
    /** The control's id: the label's `for`, and the context's control id. */
    id: string;
    /** The field's own words. */
    label: string;
    /** Whether this component draws the label; a control that draws its own hidden label sets `false`. */
    named?: boolean;
    children: Snippet;
  } = $props();

  const outer = getFormFieldContext();

  // Everything but the control and its label is the row's: description, error, state.
  const context: FormFieldContext = {
    get controlId() {
      return id;
    },
    get labelId() {
      return named ? `${id}-name` : undefined;
    },
    get describedBy() {
      return outer?.describedBy;
    },
    get descriptionId() {
      return outer?.descriptionId;
    },
    get warningId() {
      return outer?.warningId;
    },
    get managedId() {
      return outer?.managedId;
    },
    get errorId() {
      return outer?.errorId;
    },
    get invalid() {
      return outer?.invalid;
    },
    get required() {
      return outer?.required ?? false;
    },
    get disabled() {
      return outer?.disabled ?? false;
    },
  };
</script>

<FormFieldProvider {context}>
  {#if named}<label id={`${id}-name`} for={id} class="cinder-sr-only">{label}</label>{/if}
  {@render children()}
</FormFieldProvider>
