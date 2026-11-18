<script lang="ts">
  import {
    default as JsonSchemaEditor,
    type JsonSchemaValue,
  } from '@lostgradient/json-schema-editor/components/json-schema-editor/index.ts';

  let schema = $state<JsonSchemaValue>({
    type: 'object',
    properties: { name: { type: 'string' } },
  });
  const original: JsonSchemaValue = {
    type: 'object',
    properties: { name: { type: 'string' } },
  };
</script>

<div id="example-mount-json-schema-editor">
  <JsonSchemaEditor
    id="fixture-schema-editor"
    {schema}
    {original}
    onSchemaChange={(event) => (schema = event.schema)}
  />
</div>
