# Table

Full data table with header, body, and optional footer for structured tabular content.

See the [tabular family boundaries](https://github.com/stevekinney/cinder/blob/main/docs/decisions/tabular-families.md) for when to choose Table versus DataTable or DataGrid. Table is the nearest choice when you need custom native-table markup; use DataTable for runtime columns/rows and DataGrid for interactive grid semantics.

## Usage

`Table` is a compound component. Import the parent and compose its leaves via the namespace API: `Table.Header`, `Table.HeaderCell`, `Table.Body`, `Table.Row`, and `Table.Cell`.

```svelte
<script lang="ts">
  import { Table } from '@lostgradient/cinder';

  const people = [
    { name: 'Ada Lovelace', role: 'Mathematician', commits: 142 },
    { name: 'Grace Hopper', role: 'Computer Scientist', commits: 98 },
  ];
</script>

<Table caption="Recent contributors">
  <Table.Header>
    <Table.Row>
      <Table.HeaderCell>Name</Table.HeaderCell>
      <Table.HeaderCell>Role</Table.HeaderCell>
      <Table.HeaderCell align="right">Commits</Table.HeaderCell>
    </Table.Row>
  </Table.Header>
  <Table.Body>
    {#each people as person (person.name)}
      <Table.Row>
        <Table.Cell>{person.name}</Table.Cell>
        <Table.Cell>{person.role}</Table.Cell>
        <Table.Cell align="right">{person.commits}</Table.Cell>
      </Table.Row>
    {/each}
  </Table.Body>
</Table>
```

A table scrolls by default. The Table root stays a native `<table>`; Cinder generates a focusable `.cinder-table-scroll` wrapper that owns the frame (the border, the radius and the clip) and the horizontal overflow, with a visible scrollbar and a fade at the inline end, so the page never scrolls sideways. Use `scrollContainerProps` to label, style, or override attributes on that generated wrapper. When `stickyHeader` is set, the generated wrapper is the sticky header's scroll container; set a bounded block size on `scrollContainerProps` when the table should scroll vertically inside that wrapper.

### Theme column headers

Use the `--cinder-table-header-*` tokens on an ancestor to style the column headings independently of the body. The header background paints over the table’s existing header surface, so a sticky header keeps its backdrop when you use a translucent color. Use the padding tokens for the table’s density. The selection cell keeps padding sized for its checkbox. [Table header tokens](../../documentation/tokens.md#table-header)

### Tables with controls

A table whose cells hold controls (a select, a switch, a checkbox, a button) stacks instead of scrolling. Set `controls` on every cell in a column of controls, and `controls="fit"` for a control that keeps its own size. Below `stackBelow` (640px), measured on the table's own container, each row becomes a card with the name and its muted detail on the first line and the controls full width at 44px beneath.

```svelte
<Table caption="Tool access">
  <Table.Header>
    <Table.Row>
      <Table.HeaderCell>Tool</Table.HeaderCell>
      <Table.HeaderCell>Risk</Table.HeaderCell>
      <Table.HeaderCell>On</Table.HeaderCell>
      <Table.HeaderCell>Asks</Table.HeaderCell>
    </Table.Row>
  </Table.Header>
  <Table.Body>
    {#each tools as tool (tool.id)}
      <Table.Row>
        <Table.Cell as="th">{tool.name}</Table.Cell>
        <Table.Cell>{tool.risk}</Table.Cell>
        <Table.Cell controls="fit"><Checkbox aria-label={`Allow ${tool.name}`} /></Table.Cell>
        <Table.Cell controls>
          <Select id={`asks-${tool.id}`} label={`${tool.name} asks`} options={asks} />
        </Table.Cell>
      </Table.Row>
    {/each}
  </Table.Body>
</Table>
```

### Stacked on the first paint

CSS chooses whether a table stacks, by a size container query on the table's own container, so the HTML a server renders is already the stacked form on a phone, with no script. Every body cell carries its column's label in that HTML, from its header cell's `label`, so give each `Table.HeaderCell` of a table that can stack a `label` (usually its own text, `''` for a column with no name). A `fit` table's card title and empty-cell marks and its table roles are in the server HTML too. Script still adds what CSS can't do after hydration: the sort control above the cards, the sort buttons held out of the tab order, and the title tooltip. A `stackBelow` other than the defaults and `640px` brings its rules in a small inline `<style>`, so a page's content security policy must allow inline styles for it.

### Tables that fit

A records table whose values can be very long (a storage key, a URL, a model identifier) sets `fit`. The table fills its container with a fixed layout, so a value never widens it: a `truncate` cell ends its text with an ellipsis at its column's width and keeps the whole value in a tooltip a focus or a hover opens, and every other cell wraps. To size a column whose content never wraps (a status badge, a date, a short identifier with its copy button) by that content, set `sizing` on its header cell, as the next section shows; `<col>` widths still set an exact share where one is known. When the columns need more room than a phone has, set a `min-inline-size` on the table: below that floor the table scrolls inside its frame because of its column count, never because of a value.

```svelte
<Table caption="Stored values" fit style="min-inline-size: 24rem">
  <colgroup>
    <col style="width: 75%" />
    <col style="width: 25%" />
  </colgroup>
  <Table.Header>
    <Table.Row>
      <Table.HeaderCell>Key</Table.HeaderCell>
      <Table.HeaderCell align="right">Size</Table.HeaderCell>
    </Table.Row>
  </Table.Header>
  <Table.Body>
    {#each values as value (value.key)}
      <Table.Row>
        <Table.Cell truncate>{value.key}</Table.Cell>
        <Table.Cell align="right">{value.size}</Table.Cell>
      </Table.Row>
    {/each}
  </Table.Body>
</Table>
```

Below `stackBelow` a `fit` table stacks into flat rows. They draw no fill and no frame, so each row starts on the content's leading edge, the same edge as the heading above it, and keeps a small gap at its trailing edge for a control. The hover, open and current tint and a linked row's focus ring reach 12px past the row's start, so the tint never starts at the title's first glyph. The scroll box makes room for that 12px outside the content edge, so nothing clips it.

### Short columns sized to their content

By default the columns of a `fit` table share its width equally, so a one-word status column is as wide as a sentence beside it. Set `sizing` on each header cell to size the columns by what they hold. A `sizing="content"` column, for a status word, a badge, an identifier or a count, is as wide as its widest header or cell, never wider than half the table, and its cells never wrap: a value longer than half the table ends in an ellipsis, with the whole value in a tooltip. A `sizing="fill"` column, for prose, takes the width the content columns leave and wraps there. Its text runs the full width of the column: a cell holds one finding, not running text, so the prose measure doesn't apply. No width is guessed in advance, so the layout stays right when a badge or a sentence changes length, and the table still never scrolls sideways. DataTable takes the same `sizing` on a column definition.

```svelte
<Table caption="Connection checks" fit>
  <Table.Header>
    <Table.Row>
      <Table.HeaderCell sizing="content">Check</Table.HeaderCell>
      <Table.HeaderCell sizing="content">Result</Table.HeaderCell>
      <Table.HeaderCell sizing="fill">What it found</Table.HeaderCell>
    </Table.Row>
  </Table.Header>
  <Table.Body>
    {#each checks as check (check.check)}
      <Table.Row>
        <Table.Cell as="th">{check.check}</Table.Cell>
        <Table.Cell><Badge>{check.result}</Badge></Table.Cell>
        <Table.Cell>{check.found}</Table.Cell>
      </Table.Row>
    {/each}
  </Table.Body>
</Table>
```

The leaves are also named exports of `@lostgradient/cinder`.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `caption` | `string` | no | — | Accessible caption rendered as a `<caption>` element. It names the table for assistive technology but is visually hidden: the heading above the table already says what it is, and the table draws no title row of its own. |
| `class` | `string` | no | — | Additional class names merged with `.cinder-table`. |
| `density` | `"comfortable"` \| `"condensed"` \| `"spacious"` | no | `"comfortable"` | Vertical padding density for header and body cells. Defaults to `'comfortable'`. |
| `fit` | `boolean` | no | `false` | Fits the table to its container's width so a long value never makes it scroll sideways. The columns share the width equally (a fixed table layout) unless a header cell sets `sizing`: a `sizing="content"` column (a status word, a badge, an identifier, a count) is as wide as its widest value, at most half the table, and does not wrap, and a `sizing="fill"` column (prose) takes the width the content columns leave. A `truncate` cell ends its text with an ellipsis at its column's width with the full text in a tooltip, and any other cell wraps its text. Leave it off for a table whose columns should keep their natural widths and scroll when they do not fit. A `fit` table also stacks below `stackBelow`, as a list of flat rows: the `as="th"` cell (or the first cell with text) is the title, a cell with `stack="end"` sits at its inline end, a cell with `stack="status"` starts the second line, and every other cell is a line of its column's header text and its value. A table with a `controls` cell that fills its cell keeps the control layout instead. |
| `framed` | `boolean` | no | `false` | Keeps the table's own frame inside a Card. Inside a Card a table is frameless by default (the card is the frame; a box inside a box reads as clutter); set this to draw the frame anyway. It changes nothing for a table outside a Card. |
| `frameless` | `boolean` | no | `false` | Draw no outline, radius or fill around the table, for a queue or list that sits on the page. Rows keep their hairlines. |
| `scrollable` | `boolean` | no | `true` | Wraps the table in a `.cinder-table-scroll` box that owns the frame (the border, the radius and the clip) and scrolls sideways when the columns do not fit, with a visible scrollbar and a fade at the inline end. The page never scrolls sideways. Pass `false` for a table that must lay out as a bare `<table>`. When combined with `stickyHeader`, the generated wrapper is the sticky header's scroll container. Set a bounded block size on `scrollContainerProps` when the table should scroll vertically inside that wrapper. |
| `selectable` | `boolean` | no | `false` | Enables the leading selection column on the entire table. When true: - The single `TableRow` inside `TableHeader` renders a leading `<th>` with a select-all checkbox sourced from the header's props. - Every `TableRow` inside `TableBody` renders a leading selection cell. Selection is strictly controlled — the consumer owns all selection state. |
| `stackBelow` | `string` \| `false` | no | `"640px"` | Width of the table's own container below which a table whose cells hold controls, or a `fit` table, stacks. With controls, each body row becomes a card: the name and its muted detail on the first line, the controls full width at 44px beneath. A `fit` table stacks into flat rows (see `fit`). A table that is neither `fit` nor holds a `controls` cell never stacks; it scrolls. The width is the table's own container's (`.cinder-table-container`, around the scroll box), not the window's, so a table in a narrow column stacks in a wide window. CSS chooses the form, by a size container query, so the server's HTML is already the stacked form on a phone: each body cell carries its column's label (`Table.HeaderCell`'s `label`), and a `fit` table's card marks and table roles are in that HTML too. A simple CSS length such as `'640px'`; the default lengths and `'640px'` are in Cinder's stylesheet, and any other length brings the same rules in a small `<style>` beside the table, keyed to that length, so a page's content security policy must allow inline styles for it. `false` keeps the table layout at every width. A `fit` table that stacks as flat rows (no cell holds a control that fills it) stacks only below `'26rem'` (416px) by default, because flat rows read well in a narrow column; the control layout keeps 640px. |
| `stickyHeader` | `boolean` | no | `false` | When true, the header sticks to the top of the scrolling container. |
| `children` | `(opaque)` | yes | — | TableHeader, TableBody, etc. Not expressible in JSON Schema; see the component types for the signature. |
| `scrollContainerProps` | `(opaque)` | no | — | Attributes forwarded to the generated `.cinder-table-scroll` wrapper when `scrollable` is true. The wrapper is focusable by default so keyboard users can scroll read-only wide tables. When the table has a caption, or when `aria-label` or `aria-labelledby` is provided here, the wrapper becomes a named `region`; pass `role` or `tabindex` here to override those defaults. Not expressible in JSON Schema; see the component types for the signature. |
| `sort` | `(opaque)` | no | — | Bound sort state. When the user activates a sortable header, this prop is updated to reflect the new column / direction. Pass `undefined` initially when no column is sorted; the component will never write back `undefined` itself (sort always toggles to a column). Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

- `--cinder-table-header-background`
- `--cinder-table-header-font-size`
- `--cinder-table-header-foreground`
- `--cinder-table-header-padding-block`
- `--cinder-table-header-padding-block-condensed`
- `--cinder-table-header-padding-block-spacious`
- `--cinder-table-header-padding-inline`
- `--cinder-table-header-padding-inline-spacious`
- `--cinder-table-header-sorted-foreground`

<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

- `Table.Header` — the `<thead>` row group; see [`table-header`](../table-header/README.md).
- `Table.HeaderCell` — a sortable `<th>`; see [`table-header-cell`](../table-header-cell/README.md).
- `Table.Body` — the `<tbody>` row group; see [`table-body`](../table-body/README.md).
- `Table.Row` — a `<tr>` with optional selection; see [`table-row`](../table-row/README.md).
- `Table.Cell` — a `<td>` with optional alignment; see [`table-cell`](../table-cell/README.md).

<!-- generated:subcomponents:end -->
