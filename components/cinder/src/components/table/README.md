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

The leaves are also named exports of `@lostgradient/cinder`.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `caption` | `string` | no | — | Accessible caption rendered as a `<caption>` element. It names the table for assistive technology but is visually hidden: the heading above the table already says what it is, and the table draws no title row of its own. |
| `class` | `string` | no | — | Additional class names merged with `.cinder-table`. |
| `density` | `"comfortable"` \| `"condensed"` \| `"spacious"` | no | `"comfortable"` | Vertical padding density for header and body cells. Defaults to `'comfortable'`. |
| `scrollable` | `boolean` | no | `true` | Wraps the table in a `.cinder-table-scroll` box that owns the frame (the border, the radius and the clip) and scrolls sideways when the columns do not fit, with a visible scrollbar and a fade at the inline end. The page never scrolls sideways. Pass `false` for a table that must lay out as a bare `<table>`. When combined with `stickyHeader`, the generated wrapper is the sticky header's scroll container. Set a bounded block size on `scrollContainerProps` when the table should scroll vertically inside that wrapper. |
| `selectable` | `boolean` | no | `false` | Enables the leading selection column on the entire table. When true: - The single `TableRow` inside `TableHeader` renders a leading `<th>` with a select-all checkbox sourced from the header's props. - Every `TableRow` inside `TableBody` renders a leading selection cell. Selection is strictly controlled — the consumer owns all selection state. |
| `stackBelow` | `string` \| `false` | no | `"640px"` | Width of the table's own container below which a table whose cells hold controls stacks. Each body row becomes a card: the name and its muted detail on the first line, the controls full width at 44px beneath. A table with no `controls` cell never stacks; it scrolls. The width is the container's (the scroll box, or the parent when `scrollable` is false), not the window's, so a table in a narrow column stacks in a wide window. A simple CSS length such as `'640px'`; only `px`, `rem` and `em` are measured against the container, and any other unit falls back to the viewport. `false` keeps the table layout at every width. |
| `stickyHeader` | `boolean` | no | `false` | When true, the header sticks to the top of the scrolling container. |
| `children` | `(opaque)` | yes | — | TableHeader, TableBody, etc. Not expressible in JSON Schema; see the component types for the signature. |
| `scrollContainerProps` | `(opaque)` | no | — | Attributes forwarded to the generated `.cinder-table-scroll` wrapper when `scrollable` is true. The wrapper is focusable by default so keyboard users can scroll read-only wide tables. When the table has a caption, or when `aria-label` or `aria-labelledby` is provided here, the wrapper becomes a named `region`; pass `role` or `tabindex` here to override those defaults. Not expressible in JSON Schema; see the component types for the signature. |
| `sort` | `(opaque)` | no | — | Bound sort state. When the user activates a sortable header, this prop is updated to reflect the new column / direction. Pass `undefined` initially when no column is sorted; the component will never write back `undefined` itself (sort always toggles to a column). Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

- `Table.Header` — the `<thead>` row group; see [`table-header`](../table-header/README.md).
- `Table.HeaderCell` — a sortable `<th>`; see [`table-header-cell`](../table-header-cell/README.md).
- `Table.Body` — the `<tbody>` row group; see [`table-body`](../table-body/README.md).
- `Table.Row` — a `<tr>` with optional selection; see [`table-row`](../table-row/README.md).
- `Table.Cell` — a `<td>` with optional alignment; see [`table-cell`](../table-cell/README.md).

<!-- generated:subcomponents:end -->
