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

  /** A workflow's input, as the builder's fields form shows it (COR-2432, row 65s). */
  let fields = $state<JsonSchemaValue>({
    type: 'object',
    required: ['branch'],
    properties: {
      branch: { type: 'string', description: 'The branch to release from.' },
      since: {
        type: 'string',
        format: 'date',
        description: 'Only include changes merged after this date. Defaults to the last release.',
      },
    },
  });
</script>

<div id="example-mount-json-schema-editor">
  <JsonSchemaEditor
    id="fixture-schema-editor"
    {schema}
    {original}
    onSchemaChange={(event) => (schema = event.schema)}
  />
</div>

<!-- The fields form, the table alone, at the width the page gives it. -->
<div id="example-mount-fields">
  <JsonSchemaEditor
    id="fixture-schema-editor-fields"
    variant="fields"
    schema={fields}
    onSchemaChange={(event) => (fields = event.schema)}
  />
</div>

<!-- The fields form in a 350px column, as the builder's Input and Output once sat: every row's
     actions stay inside the row, in its icon menu, and the description reads under the name. -->
<div id="example-mount-fields-narrow" class="fixture-narrow-column">
  <JsonSchemaEditor
    id="fixture-schema-editor-fields-narrow"
    variant="fields"
    schema={fields}
    onSchemaChange={(event) => (fields = event.schema)}
  />
</div>

<style>
  .fixture-narrow-column {
    inline-size: 350px;
    max-inline-size: 100%;
  }
</style>
