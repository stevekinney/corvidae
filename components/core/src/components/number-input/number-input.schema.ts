import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    id: {
      type: 'string',
    },
    value: {
      anyOf: [
        {
          type: 'number',
        },
        {
          type: 'null',
        },
      ],
    },
    min: {
      type: 'number',
    },
    max: {
      type: 'number',
    },
    step: {
      type: 'number',
    },
    locale: {
      type: 'string',
    },
    disabled: {
      type: 'boolean',
    },
    required: {
      type: 'boolean',
    },
    name: {
      type: 'string',
    },
    label: {
      type: 'string',
    },
    description: {
      type: 'string',
    },
    error: {
      type: 'string',
    },
    class: {
      type: 'string',
    },
    adornment: {
      type: 'string',
      description: 'Optional non-interactive text rendered before the stepper controls.',
    },
    size: {
      enum: ['sm', 'md', 'lg'],
      description:
        'Height step from the shared `--cinder-control-height-*` scale: `sm` 28px, `md` 32px,\n`lg` 40px, the same heights as an Input of that size.',
      default: 'md',
    },
    commitWhileTyping: {
      type: 'boolean',
      description:
        'Reports each number as it is typed, not only when the field is left or Enter is pressed. Text\nthat is not a number yet (such as `-`) is not reported and does not mark the field invalid\nuntil the field is left. Leaving the field reports nothing for a number, because it was\nreported as it was typed, so a value shown rounded is not changed by a visit.',
      default: false,
    },
  },
  additionalProperties: false,
  required: ['id'],
  metadata: {
    unsupportedProps: [
      {
        name: 'format',
        reason: 'unknown-shape',
        description: 'Locale-aware formatting options passed to `Intl.NumberFormat`.',
      },
      {
        name: 'inputAttachment',
        reason: 'function-or-snippet',
        description: 'Attachment for native input access and lifecycle-scoped listeners.',
      },
      {
        name: 'onValueChange',
        reason: 'function-or-snippet',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
