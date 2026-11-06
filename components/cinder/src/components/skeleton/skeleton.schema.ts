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
      enum: ['row', 'card', 'list'],
      description:
        "Shape of the group. `'row'` stacks the bars directly; `'card'` wraps a heading bar and the\n`lines` bars in a bordered card; `'list'` draws `rows` status-first list rows.",
      default: 'row',
    },
    rows: {
      type: 'number',
      description:
        "Number of list rows to draw when `variant` is `'list'`. Each row keeps the 8rem status\ncolumn reserved, then shows two text bars and a time bar, with no leading circle, so\nnothing shifts when data arrives. Clamped to between 1 and 20. Ignored by other variants.",
      default: 3,
    },
    dayBand: {
      type: 'boolean',
      description:
        "Draw a day band (a tinted header with one bar) above the rows when `variant` is `'list'`,\nthe placeholder for a list that groups its rows by day. Ignored by other variants.",
      default: false,
    },
    label: {
      type: 'string',
      description:
        "Accessible name of the loading region, announced politely once the placeholder appears\n(for example `'Loading agents'`). The placeholder bars stay hidden from assistive\ntechnology and no spinner is drawn. Applies to the grouped variants; omit it when the\nsurrounding region already says what is loading.",
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
      description:
        'Text of the "Still loading" status. Pages replace the default with their own noun, for\nexample `\'Still loading runs. This is taking longer than usual.\'`.',
      default: 'Still loading. This is taking longer than usual.',
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
        name: 'children',
        reason: 'function-or-snippet',
        description:
          'The page\'s own placeholder, drawn instead of the bars, for a loading state whose shape is a\nwhole page (real labels and headings with placeholder values and rows). The group still owns\nthe timing: nothing is drawn until `delay` has passed, and the "Still loading" status follows\nthe content after `stillLoadingAfter`. The group is marked busy while it shows. Draw each\nplaceholder block with a `Skeleton` of its own; the content is not hidden from assistive\ntechnology, so text in it is read as written.',
      },
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
