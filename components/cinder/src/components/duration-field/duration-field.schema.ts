import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    id: {
      type: 'string',
      description: 'Unique identifier for the number input. The unit select takes `${id}-unit`.',
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
      description: 'The duration in milliseconds, or `null` when the field is empty. Bindable.',
    },
    label: {
      type: 'string',
      description:
        'Visible label. Omit inside a FormField or SettingRow, which supplies the label.',
    },
    description: {
      type: 'string',
      description: 'Helper text announced with the field.',
    },
    error: {
      type: 'string',
      description: 'Validation error; marks the field invalid.',
    },
    required: {
      type: 'boolean',
      description: 'Marks the field required.',
    },
    disabled: {
      type: 'boolean',
      description: 'Disables the number and the unit.',
    },
    name: {
      type: 'string',
      description: 'Form field name for the number as typed (in the shown unit).',
    },
    integer: {
      type: 'boolean',
      description:
        'Rounds the stored milliseconds to whole numbers, for a schema of type `integer`.',
      default: false,
    },
    unit: {
      type: 'string',
      description:
        "The unit the number is shown in, by its `value`. Starts as the largest unit that shows the\nvalue as a whole number, and follows the person's choice. Bindable.",
    },
    unitSelectable: {
      type: 'boolean',
      description:
        'Whether the person can change the unit. When `false` the unit is fixed text inside the field\'s\nframe ("30 seconds"), as a setting that always counts in seconds draws it.',
      default: true,
    },
    class: {
      type: 'string',
      description: 'Additional class merged with `.cinder-duration-field`.',
    },
  },
  additionalProperties: false,
  required: ['id'],
  metadata: {
    unsupportedProps: [
      {
        name: 'onblur',
        reason: 'function-or-snippet',
        description: 'Called when the number loses focus.',
      },
      {
        name: 'onValueChange',
        reason: 'function-or-snippet',
        description:
          'Called with the next duration in milliseconds, or `null` when the number is cleared or unparseable.',
      },
      {
        name: 'units',
        reason: 'unknown-shape',
        description:
          'The units on offer, smallest first. The default is milliseconds, seconds, minutes and hours.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
