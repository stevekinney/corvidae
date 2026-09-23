import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    density: {
      enum: ['compact', 'comfortable', 'spacious'],
      description: "Controls body row padding density. Defaults to `'comfortable'`.",
    },
    stickyHeader: {
      type: 'boolean',
      description:
        'Keeps the column header row pinned to the top edge while scrolling. Defaults to `true`.',
    },
    virtualizeRows: {
      type: 'boolean',
      description: 'Enables fixed-height row virtualization.',
    },
    virtualizeColumns: {
      type: 'boolean',
      description:
        'Enables LTR horizontal virtualization for unpinned columns. Pinned columns stay rendered.',
    },
    rowHeight: {
      type: 'number',
      description:
        'Fixed body-row pixel height used by row virtualization. Defaults to 44 when omitted or invalid.',
    },
    resizableColumns: {
      type: 'boolean',
      description:
        'Enables a pointer- and keyboard-driven resize handle on resizable\nheader cells. Off by default so existing grids render unchanged. A\ncolumn opts out individually with `resizable: false`.',
    },
    reorderableColumns: {
      type: 'boolean',
      description:
        'Enables pointer drag and keyboard reordering of header cells. Off by\ndefault so existing grids render unchanged. A column can only be\nreordered among columns that share its `pin` value — reordering never\nmoves a column across the left-pinned, unpinned, or right-pinned\ngroups.',
    },
    columnOrder: {
      type: 'array',
      items: {
        type: 'string',
      },
      description:
        'Applies a supplied column order. `$bindable` — DataGrid assigns it\ndirectly after a pointer or keyboard reorder (see `reorderableColumns`),\nin addition to calling `onColumnOrderChange`, mirroring `sortModel`.',
    },
    columnSizing: {
      type: 'object',
      additionalProperties: {
        type: 'number',
      },
      description:
        'Overrides resolved column widths by column key. `$bindable` — DataGrid\nassigns it directly after a pointer or keyboard resize (see\n`resizableColumns`), in addition to calling `onColumnSizingChange`,\nmirroring `sortModel`.',
    },
    selectionMode: {
      enum: ['none', 'single', 'multiple'],
      description:
        'Controls row-selection behavior. Cell focus and range selection remain available.',
    },
    selectionModel: {
      type: 'array',
      items: {
        type: 'string',
      },
      description: 'Controlled row-selection ids, keyed by `getRowId`.',
    },
    class: {
      type: 'string',
      description: 'Additional class names merged onto the root grid.',
    },
    search: {
      type: 'boolean',
      description:
        'Renders a toolbar above the grid (outside `role="grid"`) with a search\nfield plus next/previous match controls. Matching is case-insensitive,\nchecks every column\'s resolved value (via `getValue` when supplied) as\na string, runs 300ms after the user stops typing, and covers every row\nand column regardless of virtualization. Off by default: a grid that\ndoesn\'t opt in renders no toolbar, computes no matches, and starts no\ntimers.',
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'columnPinning',
        reason: 'unknown-shape',
        description: 'Pins supplied column keys to the left or right edge.',
      },
      {
        name: 'columns',
        reason: 'unknown-shape',
        required: true,
      },
      {
        name: 'getRowAriaLabel',
        reason: 'function-or-snippet',
        description: 'Optional accessible row label for screen-reader row summaries.',
      },
      {
        name: 'getRowId',
        reason: 'function-or-snippet',
        required: true,
        description: 'Stable row identity used for ARIA ids and row-scoped state.',
      },
      {
        name: 'onCellEdit',
        reason: 'function-or-snippet',
        description:
          "Called after an in-grid cell edit commits (Enter, Tab, or blurring the\nedit input) on an editable column. `value` is typed for the column's\nresolved `editType`: a `number` column emits a `number`, or `undefined`\nfor an empty draft — never `NaN` — and leaves the original value\nuncommitted for a draft that fails to parse as a number; every other\ncolumn emits the edited `string`. DataGrid never mutates the `rows`\nprop — apply `value` to your own data from this callback.",
      },
      {
        name: 'onColumnOrderChange',
        reason: 'function-or-snippet',
        description: 'Called after the user reorders a column and DataGrid updates `columnOrder`.',
      },
      {
        name: 'onColumnSizingChange',
        reason: 'function-or-snippet',
        description: 'Called after the user resizes a column and DataGrid updates `columnSizing`.',
      },
      {
        name: 'onSelectionModelChange',
        reason: 'function-or-snippet',
        description: 'Called when row selection changes through cell interaction.',
      },
      {
        name: 'onSortModelChange',
        reason: 'function-or-snippet',
        description: 'Called after the user changes sort order and DataGrid updates `sortModel`.',
      },
      {
        name: 'rowClass',
        reason: 'function-or-snippet',
        description: 'Additional class names for body rows.',
      },
      {
        name: 'rows',
        reason: 'generic-type-parameter',
        required: true,
      },
      {
        name: 'sortModel',
        reason: 'unknown-shape',
        description: 'Controls the row sort order used to render rows.',
      },
    ],
  },
} satisfies ComponentSchema;

export default schema as ComponentSchema;
