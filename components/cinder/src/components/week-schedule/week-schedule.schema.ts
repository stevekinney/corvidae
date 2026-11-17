import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    label: {
      type: 'string',
      description:
        'Accessible name of the list, such as "Weekly schedule". Left unset, the list is unnamed.',
    },
    liveLabel: {
      type: 'string',
      description: 'Text of the live pill. Defaults to "On now".',
    },
    class: {
      type: 'string',
      description: 'Custom class merged with `.cinder-week-schedule`.',
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'days',
        reason: 'unknown-shape',
        required: true,
        description: 'The days in reading order, one row each.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
