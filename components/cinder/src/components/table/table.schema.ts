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
        "Width of the table's own container below which a table whose cells hold controls stacks. Each\nbody row becomes a card: the name and its muted detail on the first line, the controls full\nwidth at 44px beneath. A table with no `controls` cell never stacks; it scrolls. The width\nis the container's (the scroll box, or the parent when `scrollable` is false), not the\nwindow's, so a table in a narrow column stacks in a wide window. A simple CSS length such as\n`'640px'`; only `px`, `rem` and `em` are measured against the container, and any other unit\nfalls back to the viewport. `false` keeps the table layout at every width.",
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
