<script lang="ts" module>
  export const title = 'Setting rows';
  export const description =
    'Draw a plugin-style configuration schema as Settings rows, with the key beside each label.';
</script>

<script lang="ts">
  import { SchemaForm } from '@lostgradient/schema-form';

  const schema = {
    type: 'object',
    properties: {
      searchAddress: {
        type: 'string',
        title: 'Search address',
        description: 'The service the search goes to.',
      },
      region: { type: 'string', enum: ['us', 'eu'], description: 'Where the work runs.' },
      blockedSites: {
        type: 'array',
        items: { type: 'string' },
        description: 'Sites that are never searched.',
      },
      includeSnippets: { type: 'boolean', description: 'Show an excerpt with each result.' },
      cacheMs: { type: 'number', description: 'How long a result is kept.' },
    },
    required: ['searchAddress'],
  };

  let submitted = $state('Nothing saved yet.');

  function handleSubmit(value: unknown) {
    submitted = JSON.stringify(value, null, 2);
  }
</script>

<div style="display: grid; gap: 1rem;">
  <SchemaForm
    {schema}
    variant="setting-rows"
    value={{ searchAddress: 'https://search.example', cacheMs: 300000 }}
    submitLabel="Save configuration"
    onSubmit={handleSubmit}
  />

  <section>
    <h3>Last saved</h3>
    <pre>{submitted}</pre>
  </section>
</div>
