<script lang="ts">
  import Form from './form.svelte';
  import JsonEditor from '../json-editor/json-editor.svelte';
  import type { JsonEditorDiagnostic } from '../json-editor/json-editor.types.ts';

  let { jsonDiagnostics = [] }: { jsonDiagnostics?: readonly JsonEditorDiagnostic[] } = $props();

  let diagnostics = $state<readonly JsonEditorDiagnostic[]>([]);
</script>

<Form
  novalidate
  onSubmit={async () => {
    await Promise.resolve();
    diagnostics = jsonDiagnostics;
  }}
>
  <JsonEditor
    id="goal-settings"
    label="Settings"
    value={'{\n  "retries": 3,\n  "timeoutSeconds": "ten"\n}'}
    {diagnostics}
  />
  <button type="submit">Save</button>
</Form>
