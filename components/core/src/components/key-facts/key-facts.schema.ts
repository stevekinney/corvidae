import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    label: {
      type: 'string',
      description:
        'Accessible name of the list, such as "Details". Left unset, the list is unnamed.',
    },
    class: {
      type: 'string',
      description: 'Custom class merged with `.cinder-key-facts`.',
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'items',
        reason: 'unknown-shape',
        required: true,
        description:
          'The facts in reading order. A fact wraps to the next line as a whole, and no separator glyph is drawn between facts.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
