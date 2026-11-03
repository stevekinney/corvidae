import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    value: {
      type: 'string',
      description:
        'Stable identifier used for tab selection; matches TabPanel in the default pattern.',
    },
    id: {
      type: 'string',
      description: 'Optional explicit id override; auto-generated otherwise for ARIA wiring.',
    },
    controls: {
      type: 'string',
      description:
        'Optional non-empty `aria-controls` target for caller-owned panels. Empty or\nwhitespace-only strings are treated as omitted. By default, Cinder points\nat the matching TabPanel id (`${baseId}-panel-${value}`).',
    },
    label: {
      type: 'string',
      description:
        "The plain-text name this tab has in the narrow form's select. By default it is read from the\ntab's own text once it is on the page, without the count and trailing content; pass it when\nthe label changes after the first render.",
    },
    disabled: {
      type: 'boolean',
      description: 'Disables this single tab and removes it from keyboard activation.',
      default: false,
    },
    class: {
      type: 'string',
      description: 'Additional class names merged with `.cinder-tab`.',
    },
    count: {
      type: 'number',
      description:
        "A count of things in this tab that want attention, drawn as a small pill after the label. Zero,\na negative number and `undefined` show nothing, so a healthy tab carries no chip. The count is\npart of the tab's accessible name, so it never depends on colour.",
    },
    countLabel: {
      type: 'string',
      description:
        'The words that follow the count in the pill\'s accessible name: "needs attention" gives\n"1 needs attention", so the tab reads "Workers 1 needs attention". Without it the pill\nreads as the bare number.',
    },
    countTone: {
      enum: ['neutral', 'success', 'warning', 'danger', 'info', 'accent'],
      description:
        "Tone of the count pill. Defaults to `'warning'`, the amber of a count that needs attention.",
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
        description: 'Tab label content.',
      },
      {
        name: 'trailing',
        reason: 'function-or-snippet',
        description:
          'Decorative content rendered inside an `aria-hidden` span (badges, kbd hints,\ncounters). Do NOT use for interactive controls like close buttons —\n`aria-hidden` removes the content from the accessibility tree, making any\ninteractive child unreachable by keyboard and invisible to screen readers.\n\nFor a closeable tab, render a separate `<button>` immediately after the\n`<Tab>` in the DOM (as a sibling within the tab strip) and associate it\nwith the tab via `aria-label="Close [tab name]"`. The close button must\nlive outside the `<Tab>` element entirely.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
