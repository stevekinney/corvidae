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
      description: 'Native form field name. Renders a hidden input carrying the selected value.',
    },
    textInputValue: {
      type: 'string',
      description: 'Free-text input value (the text the user has typed). Bindable.',
    },
    label: {
      type: 'string',
      description: 'Visible label rendered in a `<label>` associated via `for`.',
    },
    'aria-label': {
      type: 'string',
      description: 'Accessible name for the input when no visible label is rendered.',
    },
    placeholder: {
      type: 'string',
      description: 'Placeholder when no value is selected.',
    },
    description: {
      type: 'string',
      description: 'Helper text displayed below the input; wired via aria-describedby.',
    },
    error: {
      type: 'string',
      description: 'Validation error message; sets aria-invalid="true".',
    },
    disabled: {
      type: 'boolean',
      description: 'Disables the combobox. Inherited from a wrapping FormField when unset.',
    },
    required: {
      type: 'boolean',
      description:
        'Marks the field required: renders the required marker on the label and\nsets `aria-required` on the input. Inherited from a wrapping FormField\nwhen unset.',
    },
    maxVisibleOptions: {
      type: 'number',
      description: 'Hard cap on visible filtered options. Default 200.',
    },
    customValueAllowed: {
      type: 'boolean',
      description: 'Allow committing typed text that is not present in `options`.',
    },
    'aria-describedby': {
      type: 'string',
      description:
        'External element id(s) to compose into `aria-describedby`. Composed\nafter the component-generated description and error ids, matching the\nfield-control contract in Select. Useful for tooltip ids, counter ids,\nor any external hint.',
    },
    size: {
      enum: ['sm', 'md', 'lg'],
      description:
        'Height step from the shared `--cinder-control-height-*` scale: `sm` 28px, `md` 32px,\n`lg` 40px, the same heights as a Button of that size.',
      default: 'md',
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
        "Viewport width below which the options panel docks to the bottom edge as\na sheet (Popover's `sheetBelow`, with focus kept in the input), instead of\nanchoring to the input. A simple CSS length such as `'640px'`, or `false`\nto always anchor. Default `'640px'`.",
    },
    presentation: {
      enum: ['input', 'picker'],
      description:
        '`input` types into the closed field; `picker` is a button that opens a panel with its own\nsearch field. See `ComboboxPresentation`. `customValueAllowed` has no effect on a picker,\nwhich has no text of its own to commit.',
      default: 'input',
    },
    searchPlaceholder: {
      type: 'string',
      description:
        'Picker only: placeholder, and accessible name, of the search field in the open panel\n("Search workflows").',
      default: 'Search',
    },
    loading: {
      type: 'boolean',
      description:
        'Draw the loading state: the field keeps its label, required marker and chevron, shows\n`loadingLabel` where the value goes, and does not open.',
      default: false,
    },
    loadingLabel: {
      type: 'string',
      description: 'Text shown in the field while `loading` ("Loading workflows…").',
      default: 'Loading…',
    },
    stillLoadingAfter: {
      type: 'number',
      description:
        'While `loading`, milliseconds after which Skeleton\'s own "Still loading" status appears under\nthe field. Use `10000` for the Cinder loading rule. Omit to never show it.',
    },
    groupCountVisible: {
      type: 'boolean',
      description: "Whether a group heading shows how many of the group's options are listed.",
      default: true,
    },
    matchCountVisible: {
      type: 'boolean',
      description:
        'Picker only: show "N of M" beside the search field while something is typed in it.',
      default: false,
    },
    selectedIndicator: {
      enum: ['start', 'end'],
      description:
        'Where the check on the chosen option sits: after the text (`end`) or before it (`start`).',
      default: 'end',
    },
    class: {
      type: 'string',
      description: 'Additional class names merged with `.cinder-combobox`.',
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
          'Custom synchronous filter. Receives an option and the current input\nvalue; returns true to keep. Defaults to case-insensitive substring\nmatch on label.',
      },
      {
        name: 'footer',
        reason: 'function-or-snippet',
        description:
          'Content drawn below the options, outside the `role="listbox"` element, so the arrow keys\nnever reach it, and it stays visible while the options scroll and when none match. A link or button in it is a keyboard stop of its own, after the last\noption, reached with Tab from the field.',
      },
      {
        name: 'loadError',
        reason: 'unknown-shape',
        description:
          'The option list failed to load; see `ComboboxLoadError`. The panel shows it above the options.',
      },
      {
        name: 'noMatchLabel',
        reason: 'function-or-snippet',
        description:
          'The text of the empty panel when nothing matches, or a function of what was typed.',
      },
      {
        name: 'onCancel',
        reason: 'function-or-snippet',
        description:
          'While `loading`, called when Cancel in the "Still loading" status is pressed. The button renders only when this is set.',
      },
      {
        name: 'onRetry',
        reason: 'function-or-snippet',
        description:
          'Called when the retry button in `loadError` is pressed. The button renders only when this is set.',
      },
      {
        name: 'onValueChange',
        reason: 'function-or-snippet',
        description: 'Called when an option, or an arbitrary value when enabled, is committed.',
      },
      {
        name: 'optionMeta',
        reason: 'function-or-snippet',
        description:
          "Content drawn at the trailing edge of each row, replacing the option's `meta` text. It sits\ninside the option, so it is part of the option's accessible name.",
      },
      {
        name: 'options',
        reason: 'unknown-shape',
        required: true,
        description: 'Full set of options to filter. The sole inference source for T.',
      },
      {
        name: 'value',
        reason: 'generic-type-parameter',
        description: "Currently selected value. Bindable. `''` when nothing is selected.",
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
