export default [
  {
    name: 'representative',
    props: {
      id: 'schema-form-representative',
      submitLabel: 'Create payload',
      schema: {
        type: 'object',
        title: 'Workflow input',
        properties: {
          name: {
            type: 'string',
            title: 'Name',
            minLength: 1,
          },
          count: {
            type: 'integer',
            title: 'Count',
            minimum: 1,
          },
          enabled: {
            type: 'boolean',
            title: 'Enabled',
          },
          mode: {
            type: 'string',
            title: 'Mode',
            enum: ['fast', 'safe'],
          },
          metadata: {
            type: 'object',
            title: 'Metadata',
            properties: {
              owner: { type: 'string', title: 'Owner' },
            },
            required: ['owner'],
          },
        },
        required: ['name', 'count', 'enabled', 'mode', 'metadata'],
      },
      value: {
        name: 'Import customers',
        count: 3,
        enabled: true,
        mode: 'safe',
        metadata: { owner: 'Operations' },
      },
    },
  },
  {
    // The Settings rows a plugin's configuration is drawn as: one control at the inline end, and a
    // group under its row. At 320px the rows stack, and nothing overflows.
    name: 'setting-rows',
    props: {
      id: 'schema-form-setting-rows',
      variant: 'setting-rows',
      submitLabel: 'Save configuration',
      schema: {
        type: 'object',
        properties: {
          searchAddress: {
            type: 'string',
            title: 'Search address',
            description: 'The service the search goes to.',
          },
          region: { type: 'string', enum: ['us', 'eu'], description: 'Where the work runs.' },
          includeSnippets: { type: 'boolean', description: 'Show an excerpt with each result.' },
          cacheMs: { type: 'number', description: 'How long a result is kept.' },
          blockedSites: {
            type: 'array',
            items: { type: 'string' },
            description: 'Sites that are never searched.',
          },
          account: {
            type: 'object',
            title: 'Account',
            description: 'Who the work is billed to.',
            properties: { owner: { type: 'string', title: 'Owner' } },
          },
        },
        required: ['searchAddress'],
      },
      value: {
        searchAddress: 'https://search.example',
        region: 'eu',
        includeSnippets: true,
        cacheMs: 300000,
        blockedSites: ['example.com'],
        account: { owner: 'Operations' },
      },
    },
  },
];
