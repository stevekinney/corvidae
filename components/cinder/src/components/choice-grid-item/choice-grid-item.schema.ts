import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    value: {
      type: 'string',
      description:
        'The value this item represents. Used as the key for selection state,\nroving tabindex registration, and ARIA attributes.',
    },
    state: {
      enum: ['neutral', 'correct', 'incorrect', 'pending'],
      description:
        "Feedback state for assessment / quiz usage. Defaults to `'neutral'`.\nLayout dimensions do NOT change across states (stable cell sizing guarantee).",
    },
    disabled: {
      type: 'boolean',
      description: 'When true this item cannot be selected or focused.',
    },
    description: {
      type: 'string',
      description:
        'One sentence under the title that says what choosing this does. Drawn only when the grid is\n`variant="card"`, and linked to the item with `aria-describedby`.',
    },
    class: {
      type: 'string',
      description: 'Additional class names merged with `.cinder-choice-grid-item`.',
    },
  },
  additionalProperties: false,
  required: ['value'],
  metadata: {
    unsupportedProps: [
      {
        name: 'children',
        reason: 'function-or-snippet',
        required: true,
        description:
          'Item content — label text, or richer markup. In a card grid this is the title.',
      },
      {
        name: 'icon',
        reason: 'function-or-snippet',
        description:
          'A small icon drawn before the title. Drawn only when the grid is `variant="card"`; it is\ndecorative, so the title still names the choice.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
