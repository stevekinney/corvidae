<script lang="ts">
  /**
   * The search field of a picker's panel. The panel is drawn inside the Combobox's own form field,
   * so a plain SearchField would inherit that field's id, description, error and required state
   * through context and report the picker's validation as its own. This wrapper publishes a
   * neutral form-field context for the field it holds, so it stays an ordinary search box.
   */
  import { setFormFieldContext } from '../../_internal/form-field-context.ts';
  import SearchField from '../search-field/search-field.svelte';
  import type { SearchFieldProps } from '../search-field/search-field.types.ts';

  let { id, ...rest }: SearchFieldProps & { id: string } = $props();

  setFormFieldContext({
    // Read once, as the id the field is created with; `SearchField` warns if it ever differs.
    get controlId() {
      return id;
    },
    labelId: undefined,
    describedBy: undefined,
    descriptionId: undefined,
    warningId: undefined,
    managedId: undefined,
    errorId: undefined,
    invalid: undefined,
    required: false,
    disabled: false,
  });
</script>

<SearchField {id} {...rest} />
