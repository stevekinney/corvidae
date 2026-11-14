<script lang="ts">
  import { untrack } from 'svelte';
  import JsonEditor from './json-editor.svelte';
  import type { JsonEditorDiagnostic } from './json-editor.types.ts';

  type FixtureProps = {
    value?: string;
    /** Repeat `value`'s entries this many times, to make a long document without a long fixture. */
    entries?: number;
    rows?: number;
    diagnostics?: JsonEditorDiagnostic[];
  };

  let { value = '', entries = 0, rows, diagnostics }: FixtureProps = $props();

  function longDocument(count: number): string {
    const lines = Array.from(
      { length: count },
      (_, index) => `  "step${index + 1}": { "attempts": ${index + 1}, "enabled": true }`,
    );
    return `{\n${lines.join(',\n')}\n}`;
  }

  let source = $state(untrack(() => (entries > 0 ? longDocument(entries) : value)));
</script>

<div class="json-editor-fixture">
  <JsonEditor
    id="fixture-json-editor"
    label="Request payload"
    value={source}
    {rows}
    {diagnostics}
    onValueChange={(next) => (source = next)}
  />
</div>

<style>
  .json-editor-fixture {
    max-inline-size: 40rem;
  }
</style>
