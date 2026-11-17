# Kbd

A styled keyboard key element for displaying keyboard shortcuts in help text and command palettes.

## Usage

```svelte
<script lang="ts">
  import { Kbd } from '@lostgradient/cinder';
</script>

<Kbd label="⌘K" />
```

Inside a Button (its `shortcut` prop, or a `Kbd` nested by hand) a key is a quieter chip that takes the button's colors: a 14% wash of the button's text color, a small radius and no border, so it never draws a box inside the button's box. Under forced colors it keeps a 1px edge in the button's text color.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional class names merged with `.cinder-kbd`. |
| `label` | `string` | no | — | Key label content. |
| `size` | `"sm"` \| `"md"` | no | `"md"` | Keyboard key size. |
| `children` | `(opaque)` | no | — | Key label content. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
