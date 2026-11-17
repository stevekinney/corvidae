/**
 * Schemas the view's tests and examples share: the workflow file's schema from the design's
 * "Schemas and JSON" board, a tool input, a choice that goes beyond schedule and signal, and
 * names and values far longer than their columns. Descriptions put the line a person reads first
 * and the text written for a model after a blank line, which is what the view's "More" reveals.
 */

/** The workflow file's schema, with its keys in file order: required-first is the view's doing. */
export const workflowSchema = {
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

/** A required field with a branch's fields under its choice: where a summary goes. */
export const notifySchema = {
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

/** A tool's input: one required field and one optional. */
export const searchToolSchema = {
  type: 'object',
  required: ['searchText'],
  properties: {
    searchText: { type: 'string', description: 'Matches against agent names and descriptions.' },
    limit: { type: 'number', description: 'How many agents to return. Defaults to 10.' },
  },
};

/** The name of a required field far longer than its column, and a type with no break in it. */
export const longValuesSchema = {
  type: 'object',
  required: ['order_notes_exceptionally_long_field_name_that_keeps_going_and_going'],
  properties: {
    order_notes_exceptionally_long_field_name_that_keeps_going_and_going: {
      type: 'string',
      description: 'Free text the agent reads before it answers.',
    },
    trackingCode: {
      enum: ['QmVkS3Jvbm9zUHJpbWVWZXJ0ZXhDb250cm9sbGVyU2Vzc2lvblRva2VuQmFzZTY0…', 'other'],
      description: 'A carrier’s tracking code, kept exactly as given.',
    },
  },
};
