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
    class: {
      type: 'string',
      description: 'Additional class merged onto the `.cinder-empty-state` root element.',
    },
    headingLevel: {
      enum: [1, 2, 3, 4, 5, 6],
      description: 'Heading level for the title element.',
      default: 3,
    },
    align: {
      enum: ['center', 'start'],
      description:
        "Alignment of the content. `'center'` centres the icon, text, and action in\nthe region; `'start'` aligns them to the inline start, for a state that\nreads as instructions rather than a placeholder. A start-aligned state also leads with\na larger, semibold, default-colour title and a muted description.",
      default: 'center',
    },
  },
  additionalProperties: false,
  required: ['title'],
  metadata: {
    unsupportedProps: [
      {
        name: 'action',
        reason: 'function-or-snippet',
      },
      {
        name: 'icon',
        reason: 'function-or-snippet',
      },
    ],
  },
} satisfies ComponentSchema;

export default schema as ComponentSchema;
