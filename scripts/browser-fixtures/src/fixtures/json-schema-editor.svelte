<script lang="ts">
  import { JsonSchemaEditor, type JsonSchemaValue } from '@lostgradient/cinder';

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
