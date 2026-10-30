# TableCell

Standard td cell within a table row for displaying a single data value.

## Usage

`TableCell` is a compose-only leaf of [`Table`](../table/README.md). The idiomatic API is `Table.Cell`, reached through the parent namespace — see the [table README](../table/README.md#usage) for the composed snippet. The leaf is also a named export of `@lostgradient/cinder`.

### Truncating a column

Set `truncate` on every cell in a column whose values can be very long (storage keys, hashes, URLs). The text stays on one line and ends with an ellipsis, with the full text in the `title`, and the column stops growing at a maximum size, so one long value never makes the table scroll sideways.

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
| `controls` | `boolean` | no | `false` | Marks a cell that holds a form control (a select, an input, a button). The control fills the cell, so every control in the column shares the one width the column has, and the cell keeps a minimum width so the control stays usable. Set it on every cell in the column. |
| `truncate` | `boolean` | no | `false` | Keeps the cell's text on one line and ends it with an ellipsis. The full text is the `title`, so it shows on hover. The text may grow to a maximum inline size and no further, so one very long value (a storage key, a hash, a URL) cannot widen the table. Set it on every cell in the column. Unless you pass `title`, the title is read from the rendered text. |
| `children` | `(opaque)` | no | — | Cell content. Optional so that empty `<td>` cells (used in spanning table layouts) are a valid, non-throwing state. When omitted the cell renders empty, which is valid HTML for a `<td>`. **Note for TypeScript consumers:** the Snippet type is never called externally by consuming code — Svelte's compiler handles invocation internally. Making this optional is therefore safe as an API change: no external caller calls `props.children()` on a Svelte component's props. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
