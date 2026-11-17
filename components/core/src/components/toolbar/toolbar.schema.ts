import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    orientation: {
      enum: ['horizontal', 'vertical'],
      description:
        'Layout direction for keyboard ownership and vertical group separator placement.',
      default: 'horizontal',
    },
    class: {
      type: 'string',
      description: 'Additional class merged with `.cinder-toolbar`.',
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'children',
        reason: 'function-or-snippet',
        required: true,
        description: 'Controls rendered inside the toolbar.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
