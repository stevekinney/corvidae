# TableHeaderCell

th cell within a table header row, supporting sort indicators and column labels.

## Usage

`TableHeaderCell` is a compose-only leaf of [`Table`](../table/README.md). The idiomatic API is `Table.HeaderCell`, reached through the parent namespace — see the [table README](../table/README.md#usage) for the composed snippet. The leaf is also a named export of `@lostgradient/cinder`.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `align` | `"left"` \| `"center"` \| `"right"` | no | `"left"` | Horizontal alignment for the header cell content. Defaults to `'left'`. |
| `class` | `string` | no | — | Additional class names merged with `.cinder-table__header-cell`. |
| `column` | `string` | no | — | Column key. Required when `sortable=true` so the parent Table can track which column the user activated. |
| `label` | `string` | no | — | The column's name as text, printed beside each value while the table is stacked. It is in the server's HTML, so the first paint of a stacked table already carries every label. Usually the header's own text; `''` for a column with no name (a selection column). |
| `scope` | `"col"` \| `"colgroup"` | no | `"col"` | When set, hint to assistive tech that the column groups multiple rows. |
| `sizing` | `"content"` \| `"fill"` | no | — | How this column takes its width in a `fit` table. `'content'` is for a short value (a status word, a badge, an identifier, a count): the column is as wide as its widest header or cell, never wider than half the table (28rem for a table drawn with `scrollable={false}`, which has no scroll box to measure), and its cells do not wrap; a longer value ends in an ellipsis with the whole value in a tooltip. `'fill'` is for prose: the column takes the width the `content` columns leave and wraps, its text running the full width of the column. Left out, a column shares the width equally with the others, as every column of a `fit` table with no `sizing` does. It has no effect outside a `fit` table, or while the table is stacked. |
| `sortable` | `boolean` | no | `false` | When true, render a button inside the `<th>` and dispatch sort intents to the parent Table. The cell's `aria-sort` reflects the current sort direction (`ascending`, `descending`, or `none`). |
| `actions` | `(opaque)` | no | — | Optional controls rendered beside, but outside, the sortable button. Not expressible in JSON Schema; see the component types for the signature. |
| `children` | `(opaque)` | yes | — | Cell content (column label). Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
