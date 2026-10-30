import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description:
        'Primary heading text rendered as a heading element at the configured `headingLevel`.',
    },
    description: {
      type: 'string',
      description: 'Secondary descriptive text rendered as a paragraph below the title.',
    },
    detail: {
      type: 'string',
      description:
        'Optional technical detail, such as a fault code, rendered below the description.',
    },
    retryLabel: {
      type: 'string',
      description: 'Label of the retry button.',
      default: 'Try again',
    },
    headingLevel: {
      enum: [1, 2, 3, 4, 5, 6],
      description: 'Heading level for the title element.',
      default: 2,
    },
    variant: {
      enum: ['default', 'flat'],
      description:
        "Visual treatment. `'default'` centres a boxed danger alert in padded space.\n`'flat'` renders the same content as a start-aligned block with no box and\nno padding of its own, for a page whose container already pads it. Either\nway the error is announced as an alert.",
      default: 'default',
    },
    class: {
      type: 'string',
      description: 'Additional class merged onto the `.cinder-error-state` root element.',
    },
  },
  additionalProperties: false,
  required: ['description', 'title'],
  metadata: {
    unsupportedProps: [
      {
        name: 'onRetry',
        reason: 'function-or-snippet',
        description:
          'Called when the retry button is activated. The retry button renders only when this is given.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
