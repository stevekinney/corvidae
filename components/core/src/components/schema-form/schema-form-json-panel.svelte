<!--
  Internal control: the Edit as JSON panel, for pasting a whole input at once.
  Not part of the public API; SchemaFormBody renders it in a large form.
-->
<script lang="ts">
  import JsonEditor from '../json-editor/json-editor.svelte';

  let {
    id,
    text,
    error,
    disabled = false,
    onTextChange,
    onApply,
    onCancel,
  }: {
    id: string;
    /** The JSON source being edited. */
    text: string;
    /** Why the last Apply was refused. */
    error?: string | undefined;
    disabled?: boolean;
    onTextChange: (next: string) => void;
    onApply: () => void;
    onCancel: () => void;
  } = $props();
</script>

<div class="cinder-schema-form__json-panel">
  <JsonEditor
    {id}
    label="Input as JSON"
    description="Paste or edit the whole input, then apply it to replace the form."
    value={text}
    onValueChange={onTextChange}
    {...error !== undefined ? { error } : {}}
    {disabled}
    rows={12}
    validFeedbackVisible={false}
  />
  <div class="cinder-schema-form__actions">
    <button type="button" class="cinder-schema-form__secondary-button" {disabled} onclick={onApply}>
      Apply JSON
    </button>
    <button type="button" class="cinder-schema-form__secondary-button" onclick={onCancel}>
      Cancel
    </button>
  </div>
</div>
