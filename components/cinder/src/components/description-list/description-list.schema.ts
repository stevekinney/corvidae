import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    variant: {
      enum: ['default', 'striped', 'two-column', 'narrow'],
      description:
        'Controls the visual layout:\n- `default`: stacked rows with visible terms.\n- `striped`: alternating row backgrounds.\n- `two-column`: a muted term on the left and the value on the right, with no row dividers;\n  collapses to stacked at narrow widths.\n- `narrow`: `<dt>` is visually hidden via `.cinder-sr-only`. Only appropriate when\n  surrounding context already labels the value. NOT a general compact mode.',
    },
    stack: {
      type: 'boolean',
      description:
        'Puts every term above its value at any width. The `two-column` variant\nalready stacks once its own container is narrower than 28rem; `stack`\nstacks it regardless, for a list whose page has already chosen its phone\nlayout. Has no effect on `narrow`, whose terms stay visually hidden.',
      default: false,
    },
    class: {
      type: 'string',
      description: 'Additional class merged onto the `.cinder-description-list` root element.',
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'actions',
        reason: 'function-or-snippet',
        description:
          'Optional snippet rendered once per row. Receives the full `DescriptionListItem` so\nconsumers can build disambiguated `aria-label` strings (e.g. `aria-label="Edit ${item.term}"`).\nAny interactive element in `actions` MUST set an unambiguous `aria-label`.',
      },
      {
        name: 'items',
        reason: 'unknown-shape',
        required: true,
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
