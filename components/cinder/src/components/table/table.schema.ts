import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    caption: {
      type: 'string',
      description:
        'Accessible caption rendered as a `<caption>` element. It names the table for\nassistive technology but is visually hidden: the heading above the table\nalready says what it is, and the table draws no title row of its own.',
    },
    stickyHeader: {
      type: 'boolean',
      description: 'When true, the header sticks to the top of the scrolling container.',
      default: false,
    },
    density: {
      enum: ['comfortable', 'condensed', 'spacious'],
      description:
        "Vertical padding density for header and body cells.\nDefaults to `'comfortable'`.",
      default: 'comfortable',
    },
    selectable: {
      type: 'boolean',
      description:
        "Enables the leading selection column on the entire table. When true:\n- The single `TableRow` inside `TableHeader` renders a leading `<th>`\n  with a select-all checkbox sourced from the header's props.\n- Every `TableRow` inside `TableBody` renders a leading selection cell.\nSelection is strictly controlled — the consumer owns all selection state.",
      default: false,
    },
    scrollable: {
      type: 'boolean',
      description:
        "Wraps the table in a `.cinder-table-scroll` box that owns the frame (the border, the radius and\nthe clip) and scrolls sideways when the columns do not fit, with a visible scrollbar and a fade\nat the inline end. The page never scrolls sideways. Pass `false` for a table that must lay out\nas a bare `<table>`.\n\nWhen combined with `stickyHeader`, the generated wrapper is the sticky\nheader's scroll container. Set a bounded block size on `scrollContainerProps`\nwhen the table should scroll vertically inside that wrapper.",
      default: true,
    },
    frameless: {
      type: 'boolean',
      description:
        'Draw no outline, radius or fill around the table, for a queue or list that sits on the page.\nRows keep their hairlines.',
      default: false,
    },
    framed: {
      type: 'boolean',
      description:
        "Keeps the table's own frame inside a Card. Inside a Card a table is frameless by default (the\ncard is the frame; a box inside a box reads as clutter); set this to draw the frame anyway. It\nchanges nothing for a table outside a Card.",
      default: false,
    },
    fit: {
      type: 'boolean',
      description:
        'Fits the table to its container\'s width so a long value never makes it scroll sideways. The\ncolumns share the width (a fixed table layout: set a column\'s width on its header cell or a\n`<col>`), a `truncate` cell ends its text with an ellipsis at its column\'s width with the full\ntext in a tooltip, and any other cell wraps its text. Leave it off for a table whose columns\nshould keep their natural widths and scroll when they do not fit.\n\nA `fit` table also stacks below `stackBelow`, as a list of flat rows: the `as="th"` cell (or the\nfirst cell with text) is the title, a cell with `stack="end"` sits at its inline end, a cell\nwith `stack="status"` starts the second line, and every other cell is a line of its column\'s\nheader text and its value. A table with a `controls` cell that fills its cell keeps the control\nlayout instead.',
      default: false,
    },
    stackBelow: {
      anyOf: [
        {
          type: 'string',
        },
        {
          const: false,
        },
      ],
      description:
        "Width of the table's own container below which a table whose cells hold controls, or a `fit`\ntable, stacks. With controls, each body row becomes a card: the name and its muted detail on\nthe first line, the controls full width at 44px beneath. A `fit` table stacks into flat rows\n(see `fit`). A table that is neither `fit` nor holds a `controls` cell never stacks; it\nscrolls. The width\nis the container's (the scroll box, or the parent when `scrollable` is false), not the\nwindow's, so a table in a narrow column stacks in a wide window. A simple CSS length such as\n`'640px'`; only `px`, `rem` and `em` are measured against the container, and any other unit\nfalls back to the viewport. `false` keeps the table layout at every width. A `fit` table that\nstacks as flat rows (no cell holds a control that fills it) stacks only below `'26rem'`\n(416px) by default, because flat rows read well in a narrow column; the control layout keeps\n640px.",
      default: '640px',
    },
    class: {
      type: 'string',
      description: 'Additional class names merged with `.cinder-table`.',
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'children',
        reason: 'function-or-snippet',
        required: true,
        description: 'TableHeader, TableBody, etc.',
      },
      {
        name: 'scrollContainerProps',
        reason: 'unknown-shape',
        description:
          'Attributes forwarded to the generated `.cinder-table-scroll` wrapper when\n`scrollable` is true. The wrapper is focusable by default so keyboard users\ncan scroll read-only wide tables. When the table has a caption, or when\n`aria-label` or `aria-labelledby` is provided here, the wrapper becomes a\nnamed `region`; pass `role` or `tabindex` here to override those defaults.',
      },
      {
        name: 'sort',
        reason: 'unknown-shape',
        description:
          'Bound sort state. When the user activates a sortable header, this prop\nis updated to reflect the new column / direction.\n\nPass `undefined` initially when no column is sorted; the component will\nnever write back `undefined` itself (sort always toggles to a column).',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
