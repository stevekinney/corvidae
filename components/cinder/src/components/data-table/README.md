# DataTable

Data-driven accessible table that renders rows and columns into a real `<table>` with `<caption>`, scoped column and row headers, optional sortable columns, and a horizontal-scroll responsive container.

See the [tabular family boundaries](https://github.com/stevekinney/cinder/blob/main/docs/decisions/tabular-families.md). DataTable is the native-table convenience layer; use Table for bespoke cell composition and DataGrid when cell focus, range selection, or grid semantics are required.

## Usage

```svelte
<script lang="ts">
  import { DataTable } from '@lostgradient/cinder';
  import type { DataTableColumn } from '@lostgradient/cinder';

  type Student = { name: string; score: number };

  const columns: DataTableColumn<Student>[] = [
    { key: 'name', label: 'Name', rowHeader: true },
    { key: 'score', label: 'Score', sortable: true, align: 'end' },
  ];
  const rows: Student[] = [
    { name: 'Ada', score: 98 },
    { name: 'Grace', score: 95 },
  ];
</script>

<DataTable {columns} {rows} caption="Class roster" />
```

## Guidance

Set `virtualized` with a fixed `rowHeight` when the table is rendering thousands of same-height append-only rows. The virtualized path keeps the `<table>`, `<thead>`, and `<tbody>` semantics intact, sets `aria-rowcount` to the full logical row count, and annotates mounted body rows with full-table `aria-rowindex` values. Variable or measured body row heights are out of scope for this mode.

### Use When

- Rendering a roster, cohort, or assignment view from row/column data with real table semantics.
- Needing sortable columns with screen-reader-announced sort state out of the box.

### Avoid When

- Composing a bespoke table layout with custom cell markup — use the compositional Table family directly.
- Visualizing dense numeric magnitude across two dimensions — use matrix-chart instead.

### Cells that hold controls

Pass a `cell` snippet to draw the content of every body cell, and mark the columns that hold controls with `controls` (`'fit'` for a checkbox or switch that keeps its size). The table then stacks on a narrow container: see `Table`. Pass `rowMessage` and `hasRowMessage` for a line that spans the full row under the row it belongs to, such as a failed save.

### Groups, footer and loading more

`groupBy` opens each run of rows with a header row that names the group and, after a dot, its detail (`Today, Nov 2 · Central time`). `footer` draws a row below the last, such as "Showing 12 of 1,240 events, newest first. Scroll to load more." `onReachEnd` fires when the end scrolls into view, so a long table loads more rows by scrolling and needs no Load more button.

### Rows that open

Pass `onRowOpen` and `openRowId` to make each row open a detail pane. Rows take one tab stop, Arrow keys, Home and End move between them, Enter or Space opens, and the open row is highlighted and `aria-current`. Put the table in the list slot of `ListDetail` through its `listBody`.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `caption` | `string` | no | — | Visual caption rendered as a `<caption>` element above the table. |
| `class` | `string` | no | — | Additional class names merged onto DataTable's root wrapper element (the `<div class="cinder-data-table">` that contains the table). To style the `<table>` itself, target `.cinder-data-table table` from this class. |
| `density` | `"comfortable"` \| `"condensed"` \| `"spacious"` | no | — | Vertical padding density for header and body cells. Defaults to `'comfortable'`. |
| `height` | `string` | no | — | CSS block-size for the virtualized native scroll container. Defaults to `"24rem"` when `virtualized` is true. |
| `openRowId` | `string` \| `null` | no | — | Id of the open row, the one a detail pane shows. It is marked `aria-current` and drawn highlighted. Ids are the ones `getRowId` returns. |
| `overscan` | `number` | no | — | Extra body rows rendered before and after the visible virtualized window. Defaults to 5. |
| `resizable` | `boolean` | no | — | Enables pointer and keyboard resizing handles in column headers. |
| `rowHeight` | `number` | no | — | Fixed body row height in pixels for virtualized mode. This must match the actual rendered body row height, including density padding and any wrapping introduced by the table content. Defaults to 44. |
| `scrollable` | `boolean` | no | `true` | Draws the table inside the same scroll box a `Table` uses: it owns the border, the radius and the clip, scrolls sideways when the columns do not fit, and fades at the inline end. A virtualized table always scrolls in this box. |
| `selectable` | `"none"` \| `"single"` \| `"multiple"` | no | — | Enables checkbox-based row selection. `"none"` renders no selection controls, `"single"` allows one selected row id, and `"multiple"` allows any number. Selection state is exposed through row checkbox controls; native table rows do not emit `aria-selected`. Defaults to `"none"`. |
| `selectAllLabel` | `string` | no | — | Accessible label for the multiple-selection header checkbox. |
| `stackBelow` | `string` \| `false` | no | `"640px"` | Width of the table's own container below which a table with a `controls` column stacks, each row becoming a card with the controls on a line of their own. See `Table`. |
| `stickToBottom` | `boolean` | no | — | When true in virtualized mode, appending rows while scrolled to the bottom keeps the newest row pinned in view. Appending while scrolled up does not change the viewport. |
| `stickyHeader` | `boolean` | no | — | When true, the header sticks to the top of the scrolling container. |
| `virtualized` | `boolean` | no | — | When true, renders only the visible `<tbody>` row window plus spacer rows. Requires a fixed row height. This is intended for large, append-only tables such as live logs or event streams. |
| `cell` | `(opaque)` | no | — | Draws the content of every body cell, in place of the plain value, for cells that hold more than text: a checkbox, a select, a name with its identifier beneath. Render `{context.value}` for a column that needs nothing special. Not expressible in JSON Schema; see the component types for the signature. |
| `columns` | `(opaque)` | yes | — | Column descriptors defining the headers and cell rendering for each column. Not expressible in JSON Schema; see the component types for the signature. |
| `footer` | `(opaque)` | no | — | Content of a footer row that spans the table, below the last row: a count, a hint. The table stays one framed box. Not expressible in JSON Schema; see the component types for the signature. |
| `getRowId` | `(opaque)` | no | — | Resolves the stable row id used for selection. Defaults to `row.id` when it is a string or number, otherwise the row's current positional index. Not expressible in JSON Schema; see the component types for the signature. |
| `groupBy` | `(opaque)` | no | — | Groups consecutive rows under a header row that spans the table, such as a day. Each run of rows with the same group key follows one header, drawn as the group's `label` and, after a dot, its `detail` (the time zone). Rows are not reordered; pass them already sorted. Ignored while `virtualized`. Not expressible in JSON Schema; see the component types for the signature. |
| `hasRowMessage` | `(opaque)` | no | — | Whether a row has a message under it. Without it, every row has one while `rowMessage` is set. Not expressible in JSON Schema; see the component types for the signature. |
| `isRowSelectionDisabled` | `(opaque)` | no | — | Returns true when a row should render a disabled selection checkbox. Not expressible in JSON Schema; see the component types for the signature. |
| `onColumnResize` | `(opaque)` | no | — | Called after a column width changes through a pointer or keyboard resize handle. Not expressible in JSON Schema; see the component types for the signature. |
| `onReachEnd` | `(opaque)` | no | — | Called when the end of the table scrolls into view, and again after `rows` grows while the end is still in view, so a table loads more rows by scrolling and needs no button. Pass it only while there are more rows to load, and guard against a load already in flight. Not expressible in JSON Schema; see the component types for the signature. |
| `onRowOpen` | `(opaque)` | no | — | Makes each row open on a click, Enter or Space, and gives the rows one tab stop with Arrow keys, Home and End moving between them. A click on a control inside the row (a button, a link, a field) does not open it. Not expressible in JSON Schema; see the component types for the signature. |
| `rowMessage` | `(opaque)` | no | — | Draws a message across the full width of the table directly under a row, such as the line that says a save failed. It is a row of its own, not squeezed into a cell, and it belongs to the row above it. Which rows have one is `hasRowMessage`. Give the message `role="alert"` when it reports a failure, so it is announced. Not expressible in JSON Schema; see the component types for the signature. |
| `rows` | `(opaque)` | yes | — | Row data. Each entry is read via `column.key` for each column. Not expressible in JSON Schema; see the component types for the signature. |
| `rowSelectionLabel` | `(opaque)` | no | — | Accessible label for an individual row selection checkbox. Not expressible in JSON Schema; see the component types for the signature. |
| `selectedRowIds` | `(opaque)` | no | — | Bound selected row ids. Arrays stay arrays on update; Sets stay Sets. When omitted, DataTable starts with an empty array. Not expressible in JSON Schema; see the component types for the signature. |
| `sort` | `(opaque)` | no | — | Bound sort state. When the user activates a sortable header cell, this prop is updated with the new `{ column, direction }`. The consumer is responsible for reordering `rows` in response — DataTable does not sort internally. Pass `undefined` initially when no column is sorted; the component will never write back `undefined` itself (sort always toggles to a column). Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

- `--cinder-data-table-height`

<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
