import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: "The section's heading text.",
    },
    description: {
      type: 'string',
      description: 'Supporting line under the heading, in muted text.',
    },
    level: {
      enum: [2, 3, 4, 5, 6],
      description: 'Heading level of the title. Pick the level that fits the page outline.',
      default: 2,
    },
    class: {
      type: 'string',
      description: 'Custom class merged with `.cinder-section`.',
    },
  },
  additionalProperties: false,
  required: ['title'],
  metadata: {
    unsupportedProps: [
      {
        name: 'actions',
        reason: 'function-or-snippet',
        description:
          'Controls aligned with the heading, such as an "Add" or "See all" button. They never make the header taller than its title.',
      },
      {
        name: 'children',
        reason: 'function-or-snippet',
        description: "The section's content. Children never shrink inside a flex or scroll parent.",
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
