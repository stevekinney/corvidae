<!--
  Internal control: a key/value row list for a record field (string values under free keys).
  Not part of the public API; SchemaFormBody renders it inside the field's fieldset.
-->
<script lang="ts">
  import KeyValueEditor from '../key-value-editor/key-value-editor.svelte';
  import type { KeyValueEntry } from '../key-value-editor/key-value-editor.types.ts';

  let {
    label,
    entries,
    onValueChange,
  }: {
    /** Names the add and remove actions, so two records on one page stay distinguishable. */
    label: string;
    entries: KeyValueEntry[];
    onValueChange: (next: KeyValueEntry[]) => void;
  } = $props();
</script>

<KeyValueEditor
  {entries}
  addLabel={`Add ${label} entry`}
  removeLabel={(key) => `Remove ${label} entry${key ? ` ${key}` : ''}`}
  {onValueChange}
/>
