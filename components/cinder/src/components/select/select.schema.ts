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
      enum: ['default', 'ghost', 'inline'],
      description:
        'Visual style. `ghost` has no border or fill at rest, a neutral tint on hover and while open,\nthe focus ring wrapping the whole control, and keeps its chevron: use it for a select inside\na bordered container (a composer, an inline toolbar) so the row of controls reads as one\nsurface. `inline` sits inside a sentence ("Archive messages from [sender]"): it takes the\nsurrounding text size and weight, the `sm` height and an auto width, whatever `size` says.\n`default` is the bordered select for forms and filter bars.',
      default: 'default',
    },
    appearance: {
      enum: ['outlined', 'filled'],
      description:
        'How the bordered select is drawn. `"outlined"` is the control fill inside a 1px edge.\n`"filled"` is an inset fill inside the same 1px `--cinder-control-border` edge, which keeps\nthe 3:1 boundary the fill alone would lose, with a 12px radius, a 48px height in the\ncomfortable density and the 2px focus ring. Left unset, the select follows its density:\n`filled` under `data-density="comfortable"`, `outlined` otherwise. The `ghost`\nvariant has no fill and ignores it; `inline` is outlined unless `"filled"` is set. The\nnative caret never shows: the Cinder chevron is the only one.',
    },
    tone: {
      enum: ['default', 'accent'],
      description:
        'Colour of the value. `accent` draws it in the accent colour and weight, for the one select that\nnames what the container it sits in is about to do (the agent a new chat is with), beside\n`default` controls that only set options.',
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
    mutating: {
      type: 'boolean',
      description:
        "Marks a select that changes something. Inside a stale `<StaleRegion>` it goes inert: it can\nbe focused but not opened or changed, carries `aria-disabled`, and the region's reason\ndescribes it. It returns by itself when the region stops being stale.",
      default: false,
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
        name: 'onValueChangeRequest',
        reason: 'function-or-snippet',
        description:
          'Intercepts the option the person picked before the bindable value is written. Return a\nreplacement value to use instead, including the current value to refuse the pick; return\nnothing to accept it. The control shows what the hook returned, never the refused pick.',
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
