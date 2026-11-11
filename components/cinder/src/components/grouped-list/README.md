# GroupedList

<!-- generated:a11y-record:required -->

`GroupedList` is an inset group: one rounded surface that holds its rows, a header and footer outside the surface, and an optional quick-add first row (a leading accent "+", a borderless input, and Return to submit). Rows are `GroupedListItem` elements, whose separators start at the text.

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

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `addLabel` | `string` | no | `"Add an item"` | Accessible name of the quick-add input. |
| `addPlaceholder` | `string` | no | — | Placeholder text of the quick-add input. Left unset, it shows the label. |
| `class` | `string` | no | — | Custom class merged with `.cinder-grouped-list`. |
| `footer` | `string` | no | — | A note drawn under the group, outside its surface, in small muted text. |
| `header` | `string` | no | — | A header drawn above the group, outside its surface, in small muted text. It also names the list. |
| `children` | `(opaque)` | no | — | The rows: GroupedListItem elements. Not expressible in JSON Schema; see the component types for the signature. |
| `onItemAdd` | `(opaque)` | no | — | Adds a quick-add first row: a leading accent "+" and a borderless input. Return submits the trimmed text here and clears the input; an empty entry is ignored. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## Authoring checklist

<!-- generated:authoring:start -->
<!-- generated:authoring:end -->

## CSS Variables

<!-- generated:variables:start -->

- `--cinder-grouped-list-background`

<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->
<!-- generated:subcomponents:end -->
