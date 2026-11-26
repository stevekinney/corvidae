# GroupedList

<!-- generated:a11y-record:required -->

`GroupedList` is an inset group: one rounded surface that holds its rows, a header and footer outside the surface, and an optional quick-add first row (a leading accent "+", a borderless input, and Return to submit). Rows are `GroupedListItem` elements, whose separators start at the text.

The header, the footer and the `more` link sit outside the surface, so their text starts on the surface's own edge, which is the page edge in a normal column, not on the rows' 16px inset. Text that is not inside a surface shares the page edge; only text inside a surface takes its inset.

## Usage

```svelte
<script lang="ts">
  import { GroupedList, GroupedListItem } from '@lostgradient/cinder';
</script>

<GroupedList header="Wi-Fi" footer="Known networks join automatically.">
  <GroupedListItem href="/settings/home">
    {#snippet title()}Home{/snippet}
    {#snippet subtitle()}Connected{/snippet}
  </GroupedListItem>
  <GroupedListItem href="/settings/office">
    {#snippet title()}Office{/snippet}
  </GroupedListItem>
</GroupedList>
```

### A link to the full set

When the group shows only part of a set (the latest events of a run, the first few results), end it with `more` rather than a link placed after the `GroupedList`. The link is drawn as a `Link` in its `more` form, 8px under the group, or under its footer, on the group's edge like the header and footer. Its hit area reaches 44px under a coarse pointer without moving it.

```svelte
<GroupedList header="Recent events" more={{ label: 'View the whole History', href: '/history' }}>
  <!-- the latest three rows -->
</GroupedList>
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `addLabel` | `string` | no | `"Add an item"` | Accessible name of the quick-add input. |
| `addPlaceholder` | `string` | no | — | Placeholder text of the quick-add input. Left unset, it shows the label. |
| `class` | `string` | no | — | Custom class merged with `.cinder-grouped-list`. |
| `footer` | `string` | no | — | A note drawn under the group, outside its surface and on its edge, in small muted text. |
| `header` | `string` | no | — | A header drawn above the group, outside its surface and on its edge, in small muted text. It also names the list. |
| `children` | `(opaque)` | no | — | The rows: GroupedListItem elements. Not expressible in JSON Schema; see the component types for the signature. |
| `more` | `(opaque)` | no | — | A link to the full set when the group shows only part of it ("View the whole History"), drawn under the group as a Cinder `Link` in its `more` form, on the group's edge, as the header and footer are. It renders after `footer` when both are set. Use it instead of a link placed after the GroupedList, which nothing spaces or insets. It always navigates, so it takes an `href` and no callback. Not expressible in JSON Schema; see the component types for the signature. |
| `onItemAdd` | `(opaque)` | no | — | Adds a quick-add first row: a leading accent "+" and a borderless input. Return submits the trimmed text here and clears the input; an empty entry is ignored. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## Authoring checklist

<!-- generated:authoring:start -->
<!-- generated:authoring:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->
<!-- generated:subcomponents:end -->
