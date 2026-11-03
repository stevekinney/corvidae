# DataList

A semantic list container (`<ul role="list">`) for a homogeneous collection of records. DataList owns the list element, the list reset, and the empty state; it delegates row chrome (padding, dividers, density) to the row primitive. Each record is rendered through the `children` snippet, which **must** render an `<li>` — [`StackedListItem`](../stacked-list-item/README.md) is the recommended row.

Reach for DataList when you have a vertical list of like records. For key–value metadata about a single entity use [`DescriptionList`](../description-list/README.md); for tabular rows and columns use [`Table`](../table/README.md).

## Usage

```svelte
<script lang="ts">
  import { DataList } from '@lostgradient/cinder';
  import { StackedListItem } from '@lostgradient/cinder';

  const members = [
    { id: 'a', name: 'Alice Chen', role: 'Engineer' },
    { id: 'b', name: 'Bob Osei', role: 'Designer' },
  ];
</script>

<DataList items={members} key={(member) => member.id} density="condensed">
  {#snippet children(member)}
    <StackedListItem>
      {#snippet title()}{member.name}{/snippet}
      {#snippet meta()}{member.role}{/snippet}
    </StackedListItem>
  {/snippet}
  {#snippet empty()}
    No members yet.
  {/snippet}
</DataList>
```

A list-level `density` is inherited by every `StackedListItem` row that does not set its own `density` prop. The `empty` snippet renders inside a component-owned `<li class="cinder-data-list-empty">`, so it needs no inline styling.

## Day groups

Pass `groupBy` to put consecutive rows under a header band: it returns `{ key, label, detail }` for an item, and consecutive items with one key share a header (`Today · Monday, Nov 2`, with `Central time` at the right). Each group is a nested list named by its header, so a screen reader announces the day. Pass items already sorted; they are not reordered.

```svelte
<DataList
  items={runs}
  key={(run) => run.id}
  statusColumn
  groupBy={(run) => ({ key: run.day, label: run.dayLabel, detail: 'Central time' })}
>
  {#snippet children(run)}
    <StackedListItem href={`/runs/${run.id}`}>
      {#snippet status()}<StatusDot word={run.status} />{/snippet}
      {#snippet title()}{run.title}{/snippet}
      {#snippet time()}{run.time}{/snippet}
    </StackedListItem>
  {/snippet}
</DataList>
```

`statusColumn` keeps the 128px status column for rows that have no status, so titles line up down the whole list.

## Rows that change while you watch

Pass `insertionAnnouncement` to make the list live: a new row, such as a run that starts while the page is open, appears at the top of its group, and the function receives the number of new rows and returns the text (`1 new run`) that a polite live region speaks and draws as an accent status strip above the first group. Before any row arrives the region takes no space, so the first render announces and draws nothing, and the list holds the reader's place when the strip appears. Rows inserted above the viewport do not move what the reader is looking at: browsers with scroll anchoring already hold the position, and the list scrolls by the difference where they do not. A list scrolled to its top is left alone, so the new row is seen.

## Long values

The list wraps unbroken values (an identifier) anywhere by default, and `StackedListItem` rows clamp their titles at two lines, so no value widens the list past its frame.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional class merged onto the `.cinder-data-list` root element. |
| `density` | `"comfortable"` \| `"condensed"` | no | — | List-level density inherited by StackedListItem rows that do not set their own `density` prop. Omit to let each row use its own default. A per-row `density` always overrides this list-level value. Note: when passing a variable that may be `undefined`, spread conditionally because `exactOptionalPropertyTypes` is enabled: `{...(density ? { density } : {})}` |
| `statusColumn` | `boolean` | no | — | Keep the status column's width for every row that has no `status` (a workflow, an agent with nothing to report), so titles line up down the whole list. A row's own `statusColumn` wins. |
| `children` | `(opaque)` | yes | — | Row renderer. MUST render an `<li>` (the list root is a `<ul role="list">`). StackedListItem is the recommended row — it renders an `<li>` with leading/title/description/meta/trailing slots. Not expressible in JSON Schema; see the component types for the signature. |
| `empty` | `(opaque)` | no | — | Rendered when `items` is empty. The component automatically wraps the snippet output in `<li class="cinder-data-list-empty">`. **Do NOT wrap in an `<li>` yourself** — the component provides the `<li>` wrapper automatically. Pass only inner content (e.g. a `<p>`, a `<div>`, or plain text). Contrast with `children`, which must render an `<li>`. Not expressible in JSON Schema; see the component types for the signature. |
| `groupBy` | `(opaque)` | no | — | Group consecutive items under a header band, newest group first as the items arrive. Each group is a nested list named by its header, so a screen reader announces the day. Items are not reordered; pass them already sorted. Not expressible in JSON Schema; see the component types for the signature. |
| `insertionAnnouncement` | `(opaque)` | no | — | Announce rows inserted while the list is on screen. Called with the number of new rows; the returned text (`1 new run`) is spoken politely through a live region that is also drawn as a status strip above the first group. The first render announces nothing. Rows inserted above the viewport do not move what the reader is looking at. Not expressible in JSON Schema; see the component types for the signature. |
| `items` | `(opaque)` | yes | — | The records to render. Each is passed to `children`. Not expressible in JSON Schema; see the component types for the signature. |
| `key` | `(opaque)` | yes | — | Key extractor for stable DOM reconciliation. Svelte uses this to identify each row when the list is reordered, filtered, or updated. Without a key, rows are matched by index and the wrong row instances may receive updated props, causing O(n) churn and incorrect rendering. `svelte <DataList {items} key={(m) => m.id}> ` Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
