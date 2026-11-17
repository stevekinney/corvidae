import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    open: {
      type: 'boolean',
      description: 'Whether the region the trigger shows is open.',
    },
    controls: {
      type: 'string',
      description: 'The id of the region the trigger shows and hides, for `aria-controls`.',
    },
    class: {
      type: 'string',
      description: 'Additional class names merged with `.cinder-disclosure-trigger`.',
    },
  },
  additionalProperties: false,
  required: ['open'],
  metadata: {
    unsupportedProps: [
      {
        name: 'children',
        reason: 'function-or-snippet',
        required: true,
        description:
          "The trigger's words, and anything that reads with them, such as a count or a duration.",
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
