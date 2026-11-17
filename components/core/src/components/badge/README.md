# Badge

A small inline label for status, category, or count display.

Use Badge for a status or a short tag only: an attached count, a status word, a compact annotation. Use `Chip mode="display"` when the item is an issue label or tag. Label and value metadata for a record (an owner, a created date, a price) is not a row of badges: put it in a [`DescriptionList`](../description-list/README.md), or a [`KeyFacts`](../key-facts/README.md) row for a few typed facts.

A badge belongs with the metadata in a row's content column and never in its trailing action column, so it cannot change where an action button lands (see [`StackedListItem`](../stacked-list-item/README.md#trailing-actions)). Show a status only when it is actionable, and never beside a button that says the same thing.

## Usage

```svelte
<script lang="ts">
  import { Badge } from '@lostgradient/cinder';
</script>

<Badge variant="success">Published</Badge>
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Custom class merged with `.cinder-badge`. |
| `monospace` | `boolean` | no | `false` | Render the badge label in a monospace font. Useful for version strings, error codes, or other technical labels. |
| `severity` | `"info"` \| `"low"` \| `"medium"` \| `"high"` \| `"critical"` | no | — | Ordered severity preset; critical uses the dedicated critical token. |
| `size` | `"xs"` \| `"sm"` \| `"md"` | no | `"md"` | Size of the badge. |
| `subscriptionState` | `"active"` \| `"trialing"` \| `"past-due"` \| `"canceled"` \| `"expired"` \| `"refunded"` | no | — | Render a standardized subscription lifecycle badge without hand-wiring tone, icon, and label. |
| `truncate` | `boolean` | no | `false` | Keeps the badge within the width it is given and ends a long label with an ellipsis, with the full label in the `title`. |
| `variant` | `"neutral"` \| `"success"` \| `"warning"` \| `"danger"` \| `"info"` \| `"accent"` | no | `"neutral"` | Visual style. |
| `children` | `(opaque)` | no | — | Required badge content unless subscriptionState is provided; optional content override for the subscription preset label. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
