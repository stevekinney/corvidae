# Table · accessibility

## Pattern

Native semantic table per [WAI-ARIA Authoring Practices: Sortable Table](https://www.w3.org/WAI/ARIA/apg/patterns/grid/examples/data-grid-1/) (a simplified, non-grid variant). Cinder's Table does **not** use `role="grid"` — it relies on the implicit roles of `<table>`, `<thead>`, `<tbody>`, `<tr>`, `<th>`, `<td>`.

## Composition

```svelte
<Table bind:sort selectable>
  <TableHeader {allSelected} {someSelected} {onSelectAll}>
    <TableRow>
      <TableHeaderCell column="name" sortable>Name</TableHeaderCell>
      <TableHeaderCell column="age" sortable>Age</TableHeaderCell>
    </TableRow>
  </TableHeader>
  <TableBody>
    <TableRow
      selected={selectedIds.has('1')}
      onSelectedChange={(next) => toggle('1', next)}
      selectionLabel="Select Alice"
    >
      <TableCell>Alice</TableCell>
      <TableCell align="right">30</TableCell>
    </TableRow>
    <!-- Row explicitly opted out of selection — renders an empty alignment cell -->
    <TableRow selectionDisabled={true}>
      <TableCell>System account</TableCell>
      <TableCell align="right">—</TableCell>
    </TableRow>
  </TableBody>
</Table>
```

## Sortable headers

When a `TableHeaderCell` is `sortable`, it renders a `<button>` inside the `<th>`. Focus and keyboard activation live on the inner button (`Enter` / `Space` activate it natively); `aria-sort` lives on the `<th>` so screen readers announce "ascending", "descending", or "none" alongside the column header text.

Non-sortable header cells render plain text inside the `<th>` with no inner button. Mixing sortable and non-sortable headers in the same row is supported and expected.

## Sort state

The Table owns a bindable `sort` prop of shape `{ column: string; direction: 'ascending' | 'descending' }`. Activating a sortable header:

- If the header's `column` is not the current sort: switches to that column with `ascending` direction.
- If the header's `column` is already the current sort: toggles direction.

Cinder does **not** sort the rows — that's the consumer's responsibility. The bindable lets your data layer react to the new sort.

## Caption

Pass a `caption` prop to render a `<caption>` element above the table. This is the primary accessible name source. The caption is visually hidden (clipped to a zero-height box, not removed), so it is announced but takes no room and never sits under a sticky header. Consumers without a visible caption should provide an `aria-label` on the wrapping element.

## Sticky header

Opt-in via `stickyHeader={true}`. When the table also needs an overflow container, pass `scrollable` and configure the generated `.cinder-table-scroll` wrapper through `scrollContainerProps`; the `<thead>` pins to the top of that scrolling container via `position: sticky`.

When `scrollable` and `stickyHeader` are combined, the generated wrapper is the sticky header's scroll container. If vertical scrolling should happen inside the table region, give the wrapper a bounded block size and vertical overflow:

```svelte
<Table
  scrollable
  stickyHeader
  scrollContainerProps={{
    'aria-label': 'Scrollable invoice table',
    style: 'max-block-size: 24rem; overflow-y: auto;',
  }}
>
  ...
</Table>
```

The sort button's `:focus-visible` ring uses `z-index: 2` scoped to the focus state, lifting it above the sticky thead's stacking context. If you wrap the table in a container with `overflow: hidden`, the focus ring may be clipped regardless of z-index—that's a known CSS limitation and is not fixable with z-index alone.

## Density

Use the `density` prop to control vertical padding:

- `'comfortable'` (default) — standard row height suitable for most use cases.
- `'condensed'` — tighter padding, useful for data-heavy dashboards.
- `'spacious'` — extra breathing room for editorial contexts.

The selection column's padding does not vary with density; the checkbox is a fixed-height control.

```svelte
<Table density="condensed">...</Table>
```

## Row selection

Selection is **strictly controlled**: the Table owns no selection state. Consumers pass controlled props to every selectable row and to `TableHeader`.

### `Table.selectable`

Set `selectable={true}` on `<Table>` to enable the leading selection column. This adds a `<th>` (select-all checkbox) to the header row and a `<td>` (row checkbox or empty cell) to each body row.

### `TableHeader` props (required when `Table.selectable` is true)

- `allSelected` — boolean; drives the select-all checkbox's checked state.
- `someSelected` — boolean; when true and `allSelected` is false, the browser renders the checkbox as indeterminate and exposes `aria-checked="mixed"` to assistive tech.
- `onSelectAll` — callback receiving the next boolean; the consumer updates `allSelected`/`someSelected` in response.
- `selectAllLabel` — accessible name for the select-all checkbox. Defaults to `"Select all rows"`. If some rows use `selectionDisabled`, consider passing `"Select all selectable rows"` for accuracy.

### `TableRow` props (body rows)

Active branch — row participates in selection:

- `selected` — boolean; checked state of the row's checkbox.
- `onSelectedChange` — callback receiving the next boolean.
- `selectionLabel` — accessible name for the row's checkbox; should uniquely identify the row (e.g., `"Select Alice"`).

Opt-out branch — row is intentionally excluded from selection (renders an empty alignment cell, no checkbox):

- `selectionDisabled={true}`

Inert branch — no selection props at all. Valid when `Table.selectable` is false or the row is inside `TableHeader`.

When `Table.selectable` is true, a body row that supplies none of the above throws at mount with a developer-targeted error. Accidental omission is a hard error, not a silent fallback.

### `aria-selected`

`aria-selected` is not emitted. The component renders a native `<table>`, not a `grid` or `treegrid`, and `aria-selected` is not valid on plain table rows.

### v1 constraint: single header row

When `Table.selectable` is true, `TableHeader` supports exactly one `<TableRow>`. More than one throws at mount. Multi-row selectable headers are a planned follow-up.

## Mobile / narrow widths

Tables don't reflow gracefully. Cinder ships two patterns and recommends picking based on column shape.

**Horizontal scroll via `scrollable`.** This is the default Cinder recipe for dense or unknown-width tables. The table stays a table and the generated wrapper owns overflow:

```svelte
<Table scrollable>...</Table>
```

**Column hiding via container queries.** When the column set is stable and a few columns are nice-to-have rather than essential, hide them with `@container`-driven CSS on the cells. Wrap the table in a container, declare `container-type: inline-size`, then add a class or `data-priority` attribute to each `<th>` / `<td>` and toggle `display: none` below a threshold. The table stays a table; the column count shrinks. This works without JavaScript and keeps the existing `aria-sort`, selection, and density semantics intact.

**Stacked rows below `stackBelow`.** Below the `stackBelow` viewport width (`640px` by default; `false` turns it off) Table stacks itself: every body row becomes a block and every cell shows its column's header text above its value. The markup does not change, so the `<th>` / `<td>` relationship screen readers rely on stays intact:

- The header row leaves the layout through the visually-hidden technique, not `display: none`, so the column headers, their `aria-sort`, and the select-all checkbox stay in the accessibility tree.
- `display: block` on table parts makes some engines (Safari among them) drop table semantics, so while stacked Table gives the table, its row groups, rows, and cells their table roles explicitly (`table`, `rowgroup`, `row`, `columnheader` / `rowheader`, `cell`), and removes them when it unstacks. A part that already carries a role keeps it.
- Each cell's visible label is its column's header text, copied onto the cell as `data-cinder-stack-label` and painted by `::before`. A header cell with no text (the selection column) gives its cells no label. The labels follow rows, headers, and header text as they change.

Sorting stays on the (visually hidden) header buttons, so a stacked table offers no visible sort control. A page that needs sorting on a phone should offer it beside the table, the way the redesign's filter chips do.

## Non-goals (v1)

- Cell editing.
- Pinned columns / column resizing.
- Virtualization — rows render directly. Consumers with very long lists should paginate or use a different component.
- Aggregation, filtering, search.

These are deliberately out of scope; consumers needing them should compose their own grid on top of the primitives or use a dedicated data-grid library.
