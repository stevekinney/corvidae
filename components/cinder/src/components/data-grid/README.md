# DataGrid

ARIA data grid foundation for spreadsheet-like datasets with stable row identity, explicit column widths, keyboard navigation, row selection, cell/range selection, and pinned-column metadata.

See the [tabular family boundaries](https://github.com/stevekinney/cinder/blob/main/docs/decisions/tabular-families.md). DataGrid is the interactive-grid alternative to the native Table and DataTable families; choose Table for bespoke native markup or DataTable for data-shaped native tables.

## Usage

```svelte
<script lang="ts">
  import { DataGrid } from '@lostgradient/cinder';
  import type { DataGridColumnDef } from '@lostgradient/cinder';

  type Order = { id: string; customer: string; status: string };

  const columns: DataGridColumnDef<Order>[] = [
    { key: 'id', header: 'Order', width: 120, pin: 'left' },
    { key: 'customer', header: 'Customer', width: 220 },
    { key: 'status', header: 'Status', width: 140 },
  ];

  const rows: Order[] = [
    { id: 'ORD-1001', customer: 'Ada Lovelace', status: 'Packed' },
    { id: 'ORD-1002', customer: 'Grace Hopper', status: 'Shipped' },
  ];
</script>

<DataGrid {columns} {rows} getRowId={(row) => row.id} aria-label="Orders" />
```

## Guidance

### Use When

- Rendering an interactive tabular surface that needs grid semantics instead of native table semantics.
- You need built-in row selection, cell focus, range selection, copy behavior, and inline editing.

### Avoid When

- You only need a semantic read-only table — use DataTable or the Table family instead.
- You need resize handles or drag-to-reorder controls — DataGrid does not provide them yet.

## Editing

Mark a column `editable: true` to let its cells enter edit mode. DataGrid tracks the editing cell by stable row key plus column key — not by visual row/column index — so sorting and virtualization never lose an in-progress edit.

```svelte
<script lang="ts">
  import { DataGrid } from '@lostgradient/cinder';
  import type { DataGridColumnDef } from '@lostgradient/cinder';

  type Order = { id: string; customer: string; total: number };

  let orders = $state<Order[]>([
    { id: 'ORD-1001', customer: 'Ada Lovelace', total: 124 },
    { id: 'ORD-1002', customer: 'Grace Hopper', total: 256 },
  ]);

  const columns: DataGridColumnDef<Order>[] = [
    { key: 'customer', header: 'Customer', width: 220, editable: true },
    { key: 'total', header: 'Total', width: 120, editable: true },
  ];

  function handleCellEdit(row: Order, columnKey: string, value: unknown): void {
    orders = orders.map((order) =>
      order.id === row.id ? { ...order, [columnKey]: value } : order,
    );
  }
</script>

<DataGrid
  rows={orders}
  {columns}
  getRowId={(order) => order.id}
  onCellEdit={handleCellEdit}
  aria-label="Orders"
/>
```

- The edit surface is always Cinder's own Input, never a bespoke `<input>`. Its `type` comes from the column's `editType` (`'text'` or `'number'`) when set, otherwise from `typeof` the cell's current value — a `number` value resolves to `type="number"`, everything else resolves to `type="text"`.
- `onCellEdit(row, columnKey, value)` fires on commit. `value` is typed for the resolved edit type: a `'number'` column emits a `number`, or `undefined` for an empty draft (never `NaN`); every other column emits the edited `string`. DataGrid never mutates the `rows` prop — apply `value` to your own data, as above.
- A column that also supplies a custom `cell` snippet keeps rendering that snippet while editing, with `editing: true` in its context, instead of DataGrid's built-in Input; that column owns its own edit UI.

### Keyboard and focus contract

| Key | While focused, not editing | While editing |
| --- | --- | --- |
| `Enter` | Enters edit mode on an editable cell (existing Enter-for-selection behavior is unchanged on non-editable cells). | Commits and moves the active cell to the same column in the next row. |
| Double-click | Enters edit mode on an editable cell. | — |
| Any single printable character (no Ctrl/Meta/Alt) | Enters edit mode on an editable cell with that character as the initial draft. | Reaches the Input's text cursor as ordinary typing. |
| `Escape` | Existing grid behavior (collapses selection). | Cancels: restores the original value without calling `onCellEdit` and returns focus to the cell. |
| `Tab` / `Shift+Tab` | Existing grid navigation. | Commits and moves to the next cell (previous cell for `Shift+Tab`). |
| Arrow keys, `Home`, `End`, `PageUp`, `PageDown` | Existing grid navigation. | Reach the Input's text cursor — grid navigation does not handle them. |
| Blur (clicking elsewhere) | — | Commits. |

Focus always returns to the grid root after a commit or cancel, so `role="grid"` keyboard navigation (`aria-activedescendant`) keeps working the same way it does for click- and arrow-driven cell focus.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional class names merged onto the root grid. |
| `columnOrder` | `string`[] | no | — | Applies a supplied column order. |
| `columnSizing` | `object` | no | — | Overrides resolved column widths by column key. |
| `density` | `"compact"` \| `"comfortable"` \| `"spacious"` | no | — | Controls body row padding density. Defaults to `'comfortable'`. |
| `rowHeight` | `number` | no | — | Fixed body-row pixel height used by row virtualization. Defaults to 44 when omitted or invalid. |
| `selectionMode` | `"none"` \| `"single"` \| `"multiple"` | no | — | Controls row-selection behavior. Cell focus and range selection remain available. |
| `selectionModel` | `string`[] | no | — | Controlled row-selection ids, keyed by `getRowId`. |
| `stickyHeader` | `boolean` | no | — | Keeps the column header row pinned to the top edge while scrolling. Defaults to `true`. |
| `virtualizeColumns` | `boolean` | no | — | Enables LTR horizontal virtualization for unpinned columns. Pinned columns stay rendered. |
| `virtualizeRows` | `boolean` | no | — | Enables fixed-height row virtualization. |
| `columnPinning` | `(opaque)` | no | — | Pins supplied column keys to the left or right edge. Not expressible in JSON Schema; see the component types for the signature. |
| `columns` | `(opaque)` | yes | — | A prop whose shape is not captured by the JSON schema; see the component types for the exact signature. |
| `getRowAriaLabel` | `(opaque)` | no | — | Optional accessible row label for screen-reader row summaries. Not expressible in JSON Schema; see the component types for the signature. |
| `getRowId` | `(opaque)` | yes | — | Stable row identity used for ARIA ids and row-scoped state. Not expressible in JSON Schema; see the component types for the signature. |
| `onCellEdit` | `(opaque)` | no | — | Called after an in-grid cell edit commits (Enter, Tab, or blurring the edit input) on an editable column. `value` is typed for the column's resolved `editType`: a `number` column emits a `number`, or `undefined` for an empty draft — never `NaN` — and leaves the original value uncommitted for a draft that fails to parse as a number; every other column emits the edited `string`. DataGrid never mutates the `rows` prop — apply `value` to your own data from this callback. Not expressible in JSON Schema; see the component types for the signature. |
| `onSelectionModelChange` | `(opaque)` | no | — | Called when row selection changes through cell interaction. Not expressible in JSON Schema; see the component types for the signature. |
| `onSortModelChange` | `(opaque)` | no | — | Called after the user changes sort order and DataGrid updates `sortModel`. Not expressible in JSON Schema; see the component types for the signature. |
| `rowClass` | `(opaque)` | no | — | Additional class names for body rows. Not expressible in JSON Schema; see the component types for the signature. |
| `rows` | `(opaque)` | yes | — | A generically typed prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `sortModel` | `(opaque)` | no | — | Controls the row sort order used to render rows. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
