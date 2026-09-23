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
    columnOrder: {
      type: 'array',
      items: {
        type: 'string',
      },
      description: 'Applies a supplied column order.',
    },
    columnSizing: {
      type: 'object',
      additionalProperties: {
        type: 'number',
      },
      description: 'Overrides resolved column widths by column key.',
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
