import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    id: {
      type: 'string',
      description: 'Unique identifier — required for label association and ARIA wiring.',
    },
    name: {
      type: 'string',
      description: 'Native form field name. Emits one hidden input per selected id.',
    },
    label: {
      type: 'string',
      description: 'Visible label rendered in a `<label>` associated via `for`.',
    },
    placeholder: {
      type: 'string',
      description: 'Placeholder text when nothing is selected.',
    },
    description: {
      type: 'string',
      description: 'Helper text displayed below the trigger; wired via aria-describedby.',
    },
    error: {
      type: 'string',
      description: 'Validation error message; sets aria-invalid="true".',
    },
    warning: {
      type: 'string',
      description: 'Warning text rendered below the control and included in aria-describedby.',
    },
    disabled: {
      type: 'boolean',
      description: 'Disables the control. Inherited from a wrapping FormField when unset.',
    },
    readonly: {
      type: 'boolean',
      description: 'Prevents changing selection while still allowing viewing current selections.',
    },
    required: {
      type: 'boolean',
      description: 'Marks the field required and shows the required marker on the label.',
    },
    filterable: {
      type: 'boolean',
      description: 'Enables the filter input rendered above the options list.',
    },
    selectionFeedback: {
      enum: ['top', 'fixed', 'top-after-reopen'],
      description: 'Selected-option ordering behavior when the menu is open.',
    },
    direction: {
      enum: ['down', 'up'],
      description: 'Open direction for the floating panel.',
    },
    sheetBelow: {
      anyOf: [
        {
          type: 'string',
        },
        {
          const: false,
        },
      ],
      description:
        "Viewport width below which the options panel docks to the bottom edge as\na sheet, with the bottom Drawer's geometry, instead of anchoring to the\ntrigger. Filtering, keyboard, and dismissal behave exactly as when\nanchored. A simple CSS length such as `'640px'`, or `false` to always\nanchor. Default `'640px'`.",
    },
    size: {
      enum: ['sm', 'md', 'lg'],
      description:
        'Height step from the shared `--cinder-control-height-*` scale: `sm` 28px, `md` 32px,\n`lg` 40px, the same heights as a Button of that size.',
      default: 'md',
    },
    class: {
      type: 'string',
      description: 'Additional class names merged with `.cinder-multi-select`.',
    },
    'aria-describedby': {
      type: 'string',
      description: 'External id(s) composed into aria-describedby.',
    },
  },
  additionalProperties: false,
  required: ['id'],
  metadata: {
    unsupportedProps: [
      {
        name: 'filter',
        reason: 'function-or-snippet',
        description:
          'Custom option filter callback. Defaults to case-insensitive label/description matching.',
      },
      {
        name: 'items',
        reason: 'unknown-shape',
        required: true,
        description: 'Full option set. The sole inference source for T.',
      },
      {
        name: 'selectedIds',
        reason: 'generic-type-parameter',
        description: 'Bindable selected IDs.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
