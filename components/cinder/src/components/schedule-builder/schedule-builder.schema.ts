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
                  type: 'number',
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
    class: {
      type: 'string',
      description: 'Additional CSS classes applied to the root element.',
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'computeNextFires',
        reason: 'function-or-snippet',
        description:
          'Injected next-fires computation. The component passes the current value and\nthe requested count and renders whatever fires the consumer returns. When\nomitted, the preview list is hidden (the component ships no date logic).',
      },
      {
        name: 'onValueChange',
        reason: 'function-or-snippet',
        description:
          'Called whenever the user edits the recurrence. Receives the next\n{@link ScheduleValue}; an invalid custom cron is not emitted. The consumer owns\npersistence.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
