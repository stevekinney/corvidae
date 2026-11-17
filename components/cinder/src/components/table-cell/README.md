# TableCell

Standard td cell within a table row for displaying a single data value.

## Usage

`TableCell` is a compose-only leaf of [`Table`](../table/README.md). The idiomatic API is `Table.Cell`, reached through the parent namespace — see the [table README](../table/README.md#usage) for the composed snippet. The leaf is also a named export of `@lostgradient/cinder`.

### Truncating a column

Set `truncate` on every cell in a column whose values can be very long (storage keys, hashes, URLs). The text stays on one line and ends with an ellipsis, with the full text in a tooltip that opens on hover and on focus, and the column stops growing at a maximum size, so one long value never makes the table scroll sideways.

```svelte
<TableCell truncate>{entry.key}</TableCell>
```

### Columns of controls

Set `controls` on every cell in a column of selects, inputs or buttons. Each control fills its cell, so the controls in that column share one width.

```svelte
<TableCell controls><Select id={`role-${row.id}`} label="Role" /></TableCell>
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `align` | `"left"` \| `"center"` \| `"right"` | no | `"left"` | Visual alignment for numeric columns. |
| `as` | `"td"` \| `"th"` | no | `"td"` | When `'th'`, renders a `<th scope="row">` instead of `<td>`, marking this cell as the row-header identifier for assistive technology. The component sets `scope="row"` itself (so `scope` is not part of the prop surface). Defaults to `'td'` so existing consumers are unaffected. The attribute surface is `HTMLTdAttributes` for both modes — `<td>` and `<th>` share `HTMLTableCellElement`, so `colspan`, `rowspan`, `headers`, and `abbr` are all forwarded regardless of `as`. Only `scope` is removed from the prop surface, because the component owns it (`scope="row"` when `as='th'`). |
| `class` | `string` | no | — | Additional class names merged with `.cinder-table__cell`. |
| `controls` | `false` \| `true` \| `"fit"` | no | `false` | Marks a cell that holds a form control (a select, an input, a button). The control fills the cell, so every control in the column shares the one width the column has, and the cell keeps a minimum width so the control stays usable. Set it on every cell in the column. `'fit'` is for a control that keeps its own size, such as a checkbox or a switch: the cell does not stretch it or set a minimum width. A table that is not `fit` stacks its rows on a narrow container only while a cell has this set. When it stacks, the control cells move to a line of their own under the other cells, each at least 44px tall, and a `'fit'` cell shows its column's header text beside the control. On a `fit` table whose controls are all `'fit'`, the control sits at the trailing edge of the row and takes its own accessible name; a control that fills its cell keeps the line of its own. |
| `stack` | `"end"` \| `"status"` \| `"plain"` | no | — | The part this cell plays on a `fit` table's stacked row, below `stackBelow`: - `'end'`: a short value at the inline end of the title line (a time, a count). - `'status'`: a status that starts the second line, never cut. - `'plain'`: prose under the title, with no label. A cell with no `stack` is a line of its column's header text and its value. The title is the `as="th"` cell. It has no effect at other widths or on a table that is not `fit`. |
| `truncate` | `boolean` | no | `false` | Keeps the cell's text on one line and ends it with an ellipsis. The full text is a tooltip on hover and focus, and the text takes focus only while it is actually cut (a link inside it takes the stop instead), so a keyboard or touch user reaches it and a value that fits adds no tab stop. The text may grow to a maximum inline size and no further, so one very long value (a storage key, a hash, a URL) cannot widen the table. Set it on every cell in the column. Unless you pass `title`, the tooltip is read from the rendered text. |
| `children` | `(opaque)` | no | — | Cell content. Optional so that empty `<td>` cells (used in spanning table layouts) are a valid, non-throwing state. When omitted the cell renders empty, which is valid HTML for a `<td>`. **Note for TypeScript consumers:** the Snippet type is never called externally by consuming code — Svelte's compiler handles invocation internally. Making this optional is therefore safe as an API change: no external caller calls `props.children()` on a Svelte component's props. Not expressible in JSON Schema; see the component types for the signature. |
| `detail` | `(opaque)` | no | — | Secondary content that follows `children` in the same cell: an identifier, a description, a note. It reads as part of the cell until the table stacks its rows. A table with controls drops it from its cards, so the first line carries the name and its one-word facts only. A `fit` table's title cell keeps it as one muted line under the title, cut with an ellipsis, and drops it from every other cell. It is not a place for anything the reader needs on a phone beyond an identifier. Give it block content, so it sits under the name at every width. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
