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
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
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
