<script lang="ts" module>
  export const title = 'A choice of branches';
  export const description =
    'A oneOf of objects lists each branch\'s fields under the choice, labelled "If <choice>: <field>". The caption says how to read the branches.';
</script>

<script lang="ts">
  import { SchemaView } from '@lostgradient/cinder';

  const notifySchema = {
    type: 'object',
    required: ['notify'],
    properties: {
      notify: {
        description: 'Where the summary goes.',
        oneOf: [
          {
            type: 'object',
            required: ['kind', 'address'],
            properties: {
              kind: { const: 'email' },
              address: { type: 'string', description: 'Who receives it.' },
            },
          },
          {
            type: 'object',
            required: ['kind', 'channel'],
            properties: {
              kind: { const: 'slack' },
              channel: { type: 'string', description: 'The channel name, such as #refunds.' },
            },
          },
          {
            type: 'object',
            required: ['kind', 'url'],
            properties: {
              kind: { const: 'webhook' },
              url: { type: 'string', description: 'Called with the summary as JSON.' },
              secret: { type: 'string', description: 'Sent as a header. Never shown again.' },
            },
          },
        ],
      },
    },
  };
</script>

<SchemaView
  schema={notifySchema}
  label="Summary delivery"
  caption={'A branch\u2019s fields indent under their choice and read \u201cIf <choice>: <field>\u201d. Only the chosen branch\u2019s required dots apply.'}
/>
