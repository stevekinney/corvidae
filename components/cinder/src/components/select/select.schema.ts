import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    disabled: {
      type: 'boolean',
      description: 'Disables the control.',
    },
    required: {
      type: 'boolean',
      description: 'Marks the control required and sets the native `required` attribute.',
    },
    id: {
      type: 'string',
      description: 'Unique identifier — required for label association and ARIA wiring.',
    },
    placeholder: {
      type: 'string',
      description:
        'Listbox only: text shown in the trigger while no option is selected, such as `Loading models`.',
    },
    label: {
      type: 'string',
      description: 'Visible label rendered in a `<label>` associated via `for`.',
    },
    labelVisible: {
      type: 'boolean',
      description:
        'Whether the label is visibly rendered. Set `false` to visually hide it\nwhile keeping it available to assistive technology.',
      default: true,
    },
    description: {
      type: 'string',
      description: 'Helper text rendered below the control; wired via `aria-describedby`.',
    },
    error: {
      type: 'string',
      description:
        'Validation error message; sets `aria-invalid="true"` and is wired via `aria-describedby`.',
    },
    size: {
      enum: ['sm', 'md', 'lg'],
      description:
        'Height step from the shared `--cinder-control-height-*` scale: `sm` 28px, `md` 32px,\n`lg` 40px. Replaces the native list-box `size` attribute, which Cinder does not forward.',
      default: 'md',
    },
    variant: {
      enum: ['default', 'ghost'],
      description:
        'Visual style. `ghost` has no border or fill at rest, a neutral tint on hover and while open,\nthe focus ring wrapping the whole control, and keeps its chevron: use it for a select inside\na bordered container (a composer, an inline toolbar) so the row of controls reads as one\nsurface. `default` is the bordered select for forms and filter bars.',
      default: 'default',
    },
    presentation: {
      enum: ['native', 'listbox'],
      description:
        'Native `<select>` or a drawn listbox; see `SelectPresentation`. The listbox-only props below\n(`placeholder`, `valuePrefix`, `leading`, `footer`, `groups`, and the rich option fields) do\nnothing in the native presentation.',
      default: 'native',
    },
    valuePrefix: {
      type: 'string',
      description:
        'Listbox only: muted text drawn before the value in the trigger ("Model" before "Claude Sonnet\n5.5"). It is decorative and hidden from assistive technology; the name comes from `label`.',
    },
    readonly: {
      type: 'boolean',
      description:
        'The control shows its value and can be focused, but does not open and does not change.\nExposed as `aria-readonly` on the listbox presentation; the native presentation also blocks\nthe picker.',
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
        "Listbox only: viewport width below which the options dock to the bottom edge as a sheet. A\nsimple CSS length such as `'640px'`, or `false` to always anchor.",
      default: '640px',
    },
    class: {
      type: 'string',
      description: 'Extra class names merged with `.cinder-select-field`.',
    },
  },
  additionalProperties: false,
  required: ['id'],
  metadata: {
    unsupportedProps: [
      {
        name: 'footer',
        reason: 'function-or-snippet',
        description:
          'Listbox only: content drawn below the options, outside the `role="listbox"` element, so the\narrow keys never reach it. A link or button in it is a keyboard stop of its own, after the\nlast option, reached with Tab from the trigger.',
      },
      {
        name: 'groups',
        reason: 'unknown-shape',
        description: 'Listbox only: headings, dividers and messages for the option groups.',
      },
      {
        name: 'leading',
        reason: 'function-or-snippet',
        description:
          "Listbox only: a mark drawn before each option's label and before the selected value in the trigger, such as an avatar. Decorative.",
      },
      {
        name: 'onValueChange',
        reason: 'function-or-snippet',
        description: 'Called with the new value when the person picks an option.',
      },
      {
        name: 'options',
        reason: 'unknown-shape',
        required: true,
        description: 'Options to render as `<option>` children. The sole inference source for T.',
      },
      {
        name: 'value',
        reason: 'generic-type-parameter',
        description: 'Bound selected value. `undefined` when nothing is selected.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
