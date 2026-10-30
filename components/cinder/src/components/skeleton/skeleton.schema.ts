import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    width: {
      type: 'string',
      description:
        "CSS width value applied as an inline style on the skeleton block (e.g. `'200px'`, `'100%'`).",
    },
    height: {
      type: 'string',
      description:
        "CSS height value applied as an inline style on the skeleton block (e.g. `'1rem'`, `'48px'`).",
    },
    radius: {
      type: 'string',
      description:
        "CSS border-radius value applied as an inline style, overriding the default pill shape (e.g. `'4px'`, `'50%'`).",
    },
    class: {
      type: 'string',
      description:
        'Additional class merged onto the root element: `.cinder-skeleton` for a single block, or `.cinder-skeleton-group` when `lines`, `variant`, or `stillLoadingAfter` render a group.',
    },
    lines: {
      type: 'number',
      description:
        'Number of text bars to stack. More than one renders a group, and the last bar is shorter\nunless `width` is set. Clamped to between 1 and 20.',
      default: 1,
    },
    variant: {
      enum: ['row', 'card'],
      description:
        "Shape of the group. `'row'` stacks the bars directly; `'card'` wraps a heading bar and the\n`lines` bars in a bordered card.",
      default: 'row',
    },
    delay: {
      type: 'number',
      description:
        'Milliseconds to wait after mounting before anything renders. A load that finishes inside\nthe delay never flashes a placeholder. Use `300` for the Cinder loading rule.',
      default: 0,
    },
    stillLoadingAfter: {
      type: 'number',
      description:
        'Milliseconds after mounting at which a "Still loading" status replaces silence, with a\nCancel button when `onCancel` is set. Counted from mount, not from the end of `delay`.\nUse `10000` for the Cinder loading rule. Omit to never show the status.',
    },
    stillLoadingLabel: {
      type: 'string',
      description: 'Text of the "Still loading" status.',
      default: 'Still loading…',
    },
    cancelLabel: {
      type: 'string',
      description: 'Label of the Cancel button in the "Still loading" status.',
      default: 'Cancel',
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'onCancel',
        reason: 'function-or-snippet',
        description:
          'Called when the Cancel button in the "Still loading" status is pressed. The button renders only when this is set.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
