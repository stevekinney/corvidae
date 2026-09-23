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

## Resizing and reordering columns

Column resizing and reordering are both off by default so an existing grid renders unchanged. Opt in per grid with `resizableColumns` and `reorderableColumns`; a column opts out of resizing individually with `resizable: false`. `columnSizing` and `columnOrder` are `$bindable`, mirroring `sortModel` — DataGrid assigns them directly after a gesture and also calls `onColumnSizingChange` / `onColumnOrderChange`.

```svelte
<script lang="ts">
  import { DataGrid } from '@lostgradient/cinder';
  import type { DataGridColumnDef, DataGridColumnSizing } from '@lostgradient/cinder';

  type Order = { id: string; customer: string; total: number };

  const columns: DataGridColumnDef<Order>[] = [
    { key: 'id', header: 'Order', width: 120, pin: 'left' },
    { key: 'customer', header: 'Customer', width: 220 },
    { key: 'total', header: 'Total', width: 120 },
  ];

  let columnSizing = $state<DataGridColumnSizing>({});
  let columnOrder = $state<readonly string[]>([]);
</script>

<DataGrid
  {columns}
  rows={[]}
  getRowId={(order: Order) => order.id}
  resizableColumns
  reorderableColumns
  bind:columnSizing
  bind:columnOrder
  aria-label="Orders"
/>
```

- **Resizing (pointer).** A resizable header cell gets a `role="separator"` handle (`cursor: col-resize`) at its trailing edge. Dragging it live-updates the column's width, clamped to `minWidth`/`maxWidth`; the drag commits into `columnSizing`/`onColumnSizingChange` on pointerup, not on every pointermove. The handle stops the pointer event from reaching the header, so dragging it never triggers a sort.
- **Resizing (keyboard).** See the keyboard table below — Shift+ArrowLeft/Right resizes the focused header column by 10px, clamped the same way.
- **Reordering (pointer).** Dragging a header cell past the midpoint of a sibling shows a drop indicator and reorders on drop. **Reordering is constrained to within the same pin group** — a column can only change position among columns that share its `pin` value (unpinned columns never reorder in front of or behind a pinned column, and the two pinned groups never mix). A small movement below the drag threshold is still treated as a click, so sorting a sortable column is unaffected.
- **Reordering (keyboard).** Ctrl/Cmd+Shift+ArrowLeft/Right moves the focused header column one position within its pin group.
- **Virtualized columns.** Both gestures work with `virtualizeColumns` — the column virtualizer is told about every resize so its measured track sizes and total width stay correct, not just the resized cell's own CSS width.
- **Right-to-left.** The resize handle still sits at the header cell's trailing edge (which is the visual left in RTL) and pointer-drag direction is inverted automatically so dragging toward the column's interior always widens it, matching LTR. Reordering is inverted the same way — dragging toward the visual left in RTL moves a column later in `columnOrder`, not earlier, so a drop always lands on the side of the target the pointer is actually over.

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

### Header focus, resize, and reorder by keyboard

DataGrid's roving focus normally only ever lands on body cells — there is no separate "header is focused" mode until a grid opts into `resizableColumns` or `reorderableColumns`. When one of those is set:

| Key | Effect |
| --- | --- |
| `ArrowUp` (from the top body row, no modifiers) | Moves `aria-activedescendant` to the active column's header cell ("header focus"). |
| `ArrowLeft` / `ArrowRight` (header-focused, no modifiers) | Moves header focus to the adjacent header, in rendered order. |
| `Shift+ArrowLeft` / `Shift+ArrowRight` (header-focused) | Resizes the focused column by 10px, clamped to `minWidth`/`maxWidth` — only when `resizableColumns` and the column's own `resizable` allow it. |
| `Ctrl+Shift+ArrowLeft` / `Ctrl+Shift+ArrowRight` (or `Cmd` on macOS, header-focused) | Moves the focused column one position within its pin group — only when `reorderableColumns` is set. |
| `Enter` / `Space` (header-focused, sortable column) | Sorts, same as clicking the header. |
| `ArrowDown` or `Escape` (header-focused) | Returns focus to the body cell below the header. |

Every resize or reorder from the keyboard is announced through the same live region used elsewhere in DataGrid (for example, "Customer column resized to 190 pixels" or "Customer column moved to position 2").

This is intentionally scoped to the column of the currently active cell rather than a fully independent header roving-tabindex, since DataGrid has no such concept outside of resizing/reordering: `Shift+ArrowLeft`/`Shift+ArrowRight` on a body cell keeps its existing meaning (extending the cell selection range) and is completely unaffected — the resize/reorder shortcuts only ever fire while header focus is active.

## Search

Opt in with `search`. DataGrid renders a toolbar — built from Cinder's own Toolbar, SearchField, and Button — directly above the grid, **outside** the `role="grid"` element. Off by default: a grid that doesn't pass `search` renders no toolbar, computes no matches, and starts no timers.

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

<DataGrid {columns} {rows} getRowId={(row) => row.id} search aria-label="Orders" />
```

- **Matching.** 300ms after the user stops typing, DataGrid checks every column's resolved value (through the column's `getValue` when supplied, otherwise the row property) as a case-insensitive substring match — over every row in sorted order and every column, regardless of what row/column virtualization currently has rendered. A matching cell gets the `cinder-data-grid__cell--search-match` class; the current match additionally gets `cinder-data-grid__cell--search-match-current`.
- **Navigation.** The toolbar's previous/next buttons, or `Enter` / `Shift+Enter` in the search field, step through matches with wraparound. Stepping (and settling on the first match once typing stops) makes that cell the active cell and scrolls it into view through the same virtualization-adapter scroll-to-index path arrow-key navigation already uses, so it works identically whether or not `virtualizeRows` / `virtualizeColumns` is on.
- **Announcements.** Match position ("Match 3 of 12") and "No matches" are announced through DataGrid's existing live region.
- **Coexistence.** Search recomputes from whatever `rows`/`columns` DataGrid currently has, so committing a cell edit or changing `sortModel` updates matches and highlighting automatically — no extra wiring required.
- The search field's accessible name is derived from the grid's own `aria-label` (e.g. "Search Orders") and it sets `aria-controls` to the grid.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional class names merged onto the root grid. |
| `columnOrder` | `string`[] | no | — | Applies a supplied column order. `$bindable` — DataGrid assigns it directly after a pointer or keyboard reorder (see `reorderableColumns`), in addition to calling `onColumnOrderChange`, mirroring `sortModel`. |
| `columnSizing` | `object` | no | — | Overrides resolved column widths by column key. `$bindable` — DataGrid assigns it directly after a pointer or keyboard resize (see `resizableColumns`), in addition to calling `onColumnSizingChange`, mirroring `sortModel`. |
| `density` | `"compact"` \| `"comfortable"` \| `"spacious"` | no | — | Controls body row padding density. Defaults to `'comfortable'`. |
| `reorderableColumns` | `boolean` | no | — | Enables pointer drag and keyboard reordering of header cells. Off by default so existing grids render unchanged. A column can only be reordered among columns that share its `pin` value — reordering never moves a column across the left-pinned, unpinned, or right-pinned groups. |
| `resizableColumns` | `boolean` | no | — | Enables a pointer- and keyboard-driven resize handle on resizable header cells. Off by default so existing grids render unchanged. A column opts out individually with `resizable: false`. |
| `rowHeight` | `number` | no | — | Fixed body-row pixel height used by row virtualization. Defaults to 44 when omitted or invalid. |
| `search` | `boolean` | no | — | Renders a toolbar above the grid (outside `role="grid"`) with a search field plus next/previous match controls. Matching is case-insensitive, checks every column's resolved value (via `getValue` when supplied) as a string, runs 300ms after the user stops typing, and covers every row and column regardless of virtualization. Off by default: a grid that doesn't opt in renders no toolbar, computes no matches, and starts no timers. |
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
| `onColumnOrderChange` | `(opaque)` | no | — | Called after the user reorders a column and DataGrid updates `columnOrder`. Not expressible in JSON Schema; see the component types for the signature. |
| `onColumnSizingChange` | `(opaque)` | no | — | Called after the user resizes a column and DataGrid updates `columnSizing`. Not expressible in JSON Schema; see the component types for the signature. |
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
