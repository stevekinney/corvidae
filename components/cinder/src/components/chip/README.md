# Chip

Compact token for issue labels, free-form tags, applied filters, selected entities, and removable or toggleable choices.

Use `Chip mode="display"` for issue labels and short tags only. Use Badge for attached counts, statuses, and compact annotations. Label and value metadata for a record (an owner, a created date, a price) is not a row of chips: put it in a [`DescriptionList`](../description-list/README.md), or a [`KeyFacts`](../key-facts/README.md) row for a few typed facts, so the labels line up and the values read as text.

## Usage

```svelte
<script lang="ts">
  import { Chip } from '@lostgradient/cinder';
</script>

<Chip label="frontend" mode="display" variant="info" />
```

## Filled, and a selection that reads louder

A chip is filled and never outlined: an unselected chip is a tone step on its surface with no edge. A selected toggle chip (`pressed`) is louder than an unselected one and never a solid accent fill: it takes the accent tint, the accent label, a 1.5px accent ring inside its edge and a check glyph before its label, so the selection is not carried by colour alone. A toggle chip is a control, so it is at least `--cinder-control-height-xs` tall and a coarse pointer lifts it to the 44px touch target; a display chip is a label and keeps its compact height.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `brandColor` | `string` | no | — | Optional third-party brand color mixed toward the foreground for legibility. |
| `breakable` | `boolean` | no | — | Allow long entity URLs to wrap at any character. |
| `class` | `string` | no | — | Additional class names merged onto the chip element. |
| `density` | `"toolbar"` | no | — | When set to `"toolbar"`, opts the chip into compact toolbar sizing to align with sibling toolbar controls. |
| `disabled` | `boolean` | no | — | Toggle mode only. When true, disables the toggle button and prevents interaction. |
| `label` | `string` | yes | — | Visible text content of the chip. |
| `mode` | `"display"` \| `"toggle"` \| `"removable"` | no | — | Rendering and interaction mode. Default `"display"`. |
| `pressed` | `boolean` | no | — | Toggle mode only. Whether the chip is currently in the pressed (selected) state. Reflected as `aria-pressed`. |
| `removeAriaLabel` | `string` | no | — | Removable mode only. Accessible label for the remove button. Defaults to `Remove` followed by the chip's `label`. |
| `size` | `"sm"` \| `"md"` | no | — | Size of the chip. Default `"md"`. |
| `variant` | `"neutral"` \| `"success"` \| `"warning"` \| `"danger"` \| `"info"` \| `"accent"` | no | — | Color variant applied to the chip. Default `"neutral"`. |
| `leadingIcon` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onPressedChange` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onRemove` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
