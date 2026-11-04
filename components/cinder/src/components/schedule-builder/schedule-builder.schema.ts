import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    value: {
      anyOf: [
        {
          type: 'object',
          properties: {
            cron: {
              type: 'string',
            },
            timeZone: {
              type: 'string',
            },
          },
          additionalProperties: false,
          required: ['cron', 'timeZone'],
        },
        {
          type: 'object',
          properties: {
            every: {
              type: 'object',
              properties: {
                unit: {
                  enum: ['minutes', 'hours'],
                },
                count: {
                  type: 'integer',
                  minimum: 1,
                },
              },
              additionalProperties: false,
              required: ['count', 'unit'],
            },
            timeZone: {
              type: 'string',
            },
          },
          additionalProperties: false,
          required: ['every', 'timeZone'],
        },
      ],
      description:
        "The current recurrence value (controlled). When omitted, the component\nstarts from every day at 9:00 AM (`0 9 * * *`) in the browser's time zone.",
    },
    previewCount: {
      type: 'integer',
      description: 'How many upcoming fires to request from `computeNextFires`. Defaults to 5.',
      minimum: 1,
    },
    timeZones: {
      type: 'array',
      items: {
        type: 'string',
      },
      description:
        'The time zones the Time zone field offers. Defaults to every zone the runtime knows.',
    },
    label: {
      type: 'string',
      description: 'Accessible label for the whole control. Defaults to "Schedule".',
    },
    variant: {
      enum: ['default', 'compact'],
      description:
        'How the block is laid out: the full block with a Runs panel (`default`), or one row of fields\nand a plain Next runs list (`compact`).',
      default: 'default',
    },
    overlap: {
      type: 'string',
      description: 'The chosen overlap policy. The overlap select is drawn only when this is set.',
    },
    overlapLabel: {
      type: 'string',
      description: 'Label of the overlap select.',
      default: 'If a run is still going',
    },
    catchUp: {
      type: 'boolean',
      description:
        'Whether to catch up on occurrences missed while the app was off. The select is drawn only when this is set.',
    },
    catchUpLabel: {
      type: 'string',
      description: 'Label of the catch-up select.',
      default: 'If the app was off',
    },
    class: {
      type: 'string',
      description: 'Additional CSS classes applied to the root element.',
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'catchUpOptionLabels',
        reason: 'unknown-shape',
        description: "The words of the catch-up select's two choices.",
      },
      {
        name: 'computeNextFires',
        reason: 'function-or-snippet',
        description:
          'Injected next-fires computation. The component passes the current value and\nthe requested count and renders whatever fires the consumer returns. When\nomitted, the preview list is hidden (the component ships no date logic).',
      },
      {
        name: 'onCatchUpChange',
        reason: 'function-or-snippet',
        description: 'Called with `true` or `false` when the catch-up select changes.',
      },
      {
        name: 'onOverlapChange',
        reason: 'function-or-snippet',
        description: "Called with the picked choice's `value` when the overlap select changes.",
      },
      {
        name: 'onValueChange',
        reason: 'function-or-snippet',
        description:
          'Called whenever the user edits the recurrence. Receives the next\n{@link ScheduleValue}; an invalid custom cron is not emitted. The consumer owns\npersistence.',
      },
      {
        name: 'overlapOptions',
        reason: 'unknown-shape',
        description: 'The choices of the overlap select. Defaults to skip and allow.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
