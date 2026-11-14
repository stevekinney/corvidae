<script lang="ts" module>
  export const title = "A workflow file's schema";
  export const description =
    'Field, Type and Description on one grid. Required fields come first, marked by a red dot after the label, with one hairline before the rest. Each type is a coloured mark with its facts (allowed values, default, format, limits) under the description, nested rows indent under their parent, and More opens the model-facing text in place.';
</script>

<script lang="ts">
  import { SchemaView } from '@lostgradient/cinder';

  const workflowSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['steps', 'trigger'],
    properties: {
      title: {
        type: 'string',
        description:
          'The heading people see, with the identifier small beside it. Optional; without it the identifier shows.\n\nThe model sees this too, so keep it short.',
      },
      description: {
        type: 'string',
        description: 'What the workflow is for.\n\nThe model reads this to decide when to use it.',
      },
      id: {
        type: 'string',
        description:
          'Required when there is no title; otherwise derived from it.\n\nThe model sees this too, so keep it plain. Used in lists and the run timeline.',
      },
      steps: {
        type: 'array',
        description:
          'The work to do, in order.\n\nEach step is an activity or a wait. Steps run top to bottom.',
        items: {
          type: 'object',
          required: ['name', 'kind'],
          properties: {
            name: { type: 'string', description: 'What this step is called in the run timeline.' },
            title: {
              type: 'string',
              description: 'A friendly name shown in the builder and the run timeline. Optional.',
            },
            kind: {
              type: 'string',
              enum: ['activity', 'wait'],
              description: 'Whether the step does work or waits for something.',
            },
            handler: { type: 'string', description: 'The agent or tool that runs an activity.' },
          },
        },
      },
      trigger: {
        description: 'What starts a run.\n\nChoose manual if only you start it.',
        oneOf: [
          {
            type: 'object',
            required: ['kind', 'cron'],
            properties: {
              kind: { const: 'schedule' },
              cron: {
                type: 'string',
                description: 'When to run, as a cron expression such as 0 9 * * *.',
              },
              timeZone: { type: 'string', description: 'Defaults to UTC.' },
              catchUp: {
                type: 'boolean',
                description: 'Whether to run times missed while the server was off.',
              },
            },
          },
          {
            type: 'object',
            required: ['kind', 'signalName'],
            properties: {
              kind: { const: 'signal' },
              signalName: { type: 'string', description: 'The signal that starts a run.' },
            },
          },
          { type: 'object', required: ['kind'], properties: { kind: { const: 'manual' } } },
        ],
      },
      inputSchema: {
        $ref: 'https://json-schema.org/draft/2020-12/schema',
        description: 'The shape of the input a run accepts.\n\nUse JSON Schema.',
      },
      outputSchema: {
        $ref: 'https://json-schema.org/draft/2020-12/schema',
        description: 'The shape of the result a run returns.',
      },
      paused: { type: 'boolean', description: 'Create the workflow without starting runs.' },
    },
  };
</script>

<SchemaView schema={workflowSchema} label="Workflow file" />
