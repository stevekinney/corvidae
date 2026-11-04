import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    caption: {
      type: 'string',
      description: 'Visual caption rendered as a `<caption>` element above the table.',
    },
    selectable: {
      enum: ['none', 'single', 'multiple'],
      description:
        'Enables checkbox-based row selection. `"none"` renders no selection controls,\n`"single"` allows one selected row id, and `"multiple"` allows any number.\nSelection state is exposed through row checkbox controls; native table rows\ndo not emit `aria-selected`.\nDefaults to `"none"`.',
    },
    selectAllLabel: {
      type: 'string',
      description: 'Accessible label for the multiple-selection header checkbox.',
    },
    stickyHeader: {
      type: 'boolean',
      description: 'When true, the header sticks to the top of the scrolling container.',
    },
    density: {
      enum: ['comfortable', 'condensed', 'spacious'],
      description:
        "Vertical padding density for header and body cells.\nDefaults to `'comfortable'`.",
    },
    scrollable: {
      type: 'boolean',
      description:
        'Draws the table inside the same scroll box a `Table` uses: it owns the border, the radius and\nthe clip, scrolls sideways when the columns do not fit, and fades at the inline end. A\nvirtualized table always scrolls in this box.',
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
        "Width of the table's own container below which a table with a `controls` column stacks, each\nrow becoming a card with the controls on a line of their own. See `Table`.",
      default: '640px',
    },
    openRowId: {
      anyOf: [
        {
          type: 'string',
        },
        {
          type: 'null',
        },
      ],
      description:
        'Id of the open row, the one a detail pane shows. It is marked `aria-current` and drawn\nhighlighted. Ids are the ones `getRowId` returns.',
    },
    resizable: {
      type: 'boolean',
      description: 'Enables pointer and keyboard resizing handles in column headers.',
    },
    virtualized: {
      type: 'boolean',
      description:
        'When true, renders only the visible `<tbody>` row window plus spacer rows.\nRequires a fixed row height. This is intended for large, append-only tables\nsuch as live logs or event streams.',
    },
    rowHeight: {
      type: 'number',
      description:
        'Fixed body row height in pixels for virtualized mode.\nThis must match the actual rendered body row height, including density\npadding and any wrapping introduced by the table content.\nDefaults to 44.',
    },
    overscan: {
      type: 'number',
      description:
        'Extra body rows rendered before and after the visible virtualized window.\nDefaults to 5.',
    },
    height: {
      type: 'string',
      description:
        'CSS block-size for the virtualized native scroll container.\nDefaults to `"24rem"` when `virtualized` is true.',
    },
    stickToBottom: {
      type: 'boolean',
      description:
        'When true in virtualized mode, appending rows while scrolled to the bottom\nkeeps the newest row pinned in view. Appending while scrolled up does not\nchange the viewport.',
    },
    class: {
      type: 'string',
      description:
        'Additional class names merged onto DataTable\'s root wrapper element (the\n`<div class="cinder-data-table">` that contains the table). To style the\n`<table>` itself, target `.cinder-data-table table` from this class.',
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'cell',
        reason: 'function-or-snippet',
        description:
          'Draws the content of every body cell, in place of the plain value, for cells that hold more\nthan text: a checkbox, a select, a name with its identifier beneath. Render\n`{context.value}` for a column that needs nothing special.',
      },
      {
        name: 'columns',
        reason: 'unknown-shape',
        required: true,
        description: 'Column descriptors defining the headers and cell rendering for each column.',
      },
      {
        name: 'footer',
        reason: 'function-or-snippet',
        description:
          'Content of a footer row that spans the table, below the last row: a count, a hint. The table\nstays one framed box.',
      },
      {
        name: 'getRowId',
        reason: 'function-or-snippet',
        description:
          "Resolves the stable row id used for selection. Defaults to `row.id` when it\nis a string or number, otherwise the row's current positional index.",
      },
      {
        name: 'groupBy',
        reason: 'function-or-snippet',
        description:
          "Groups consecutive rows under a header row that spans the table, such as a day. Each run of\nrows with the same group key follows one header, drawn as the group's `label` and, after a dot,\nits `detail` (the time zone). Rows are not reordered; pass them already sorted. Ignored while\n`virtualized`.",
      },
      {
        name: 'hasRowMessage',
        reason: 'function-or-snippet',
        description:
          'Whether a row has a message under it. Without it, every row has one while `rowMessage` is set.',
      },
      {
        name: 'isRowSelectionDisabled',
        reason: 'function-or-snippet',
        description: 'Returns true when a row should render a disabled selection checkbox.',
      },
      {
        name: 'onColumnResize',
        reason: 'function-or-snippet',
        description:
          'Called after a column width changes through a pointer or keyboard resize handle.',
      },
      {
        name: 'onReachEnd',
        reason: 'function-or-snippet',
        description:
          'Called when the end of the table scrolls into view, and again after `rows` grows while the end\nis still in view, so a table loads more rows by scrolling and needs no button. Pass it only\nwhile there are more rows to load, and guard against a load already in flight.',
      },
      {
        name: 'onRowOpen',
        reason: 'function-or-snippet',
        description:
          'Makes each row open on a click, Enter or Space, and gives the rows one tab stop with Arrow keys,\nHome and End moving between them. A click on a control inside the row (a button, a link, a\nfield) does not open it.',
      },
      {
        name: 'rowMessage',
        reason: 'function-or-snippet',
        description:
          'Draws a message across the full width of the table directly under a row, such as the line\nthat says a save failed. It is a row of its own, not squeezed into a cell, and it belongs to\nthe row above it. Which rows have one is `hasRowMessage`. Give the message `role="alert"` when\nit reports a failure, so it is announced.',
      },
      {
        name: 'rows',
        reason: 'generic-type-parameter',
        required: true,
        description: 'Row data. Each entry is read via `column.key` for each column.',
      },
      {
        name: 'rowSelectionLabel',
        reason: 'function-or-snippet',
        description: 'Accessible label for an individual row selection checkbox.',
      },
      {
        name: 'selectedRowIds',
        reason: 'unknown-shape',
        description:
          'Bound selected row ids. Arrays stay arrays on update; Sets stay Sets.\nWhen omitted, DataTable starts with an empty array.',
      },
      {
        name: 'sort',
        reason: 'unknown-shape',
        description:
          'Bound sort state. When the user activates a sortable header cell, this prop\nis updated with the new `{ column, direction }`. The consumer is responsible\nfor reordering `rows` in response — DataTable does not sort internally.\n\nPass `undefined` initially when no column is sorted; the component will never\nwrite back `undefined` itself (sort always toggles to a column).',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
