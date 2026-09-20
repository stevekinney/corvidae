# ZoomPanViewer

An accessible viewport for panning and zooming images, SVGs, and Mermaid diagrams.

## Usage

```svelte
<script lang="ts">
  import { ZoomPanViewer } from '@corvidae/cinder';
</script>

<ZoomPanViewer ariaLabel="Architecture diagram">
  {#snippet children()}
    <div
      style="min-width: 36rem; min-height: 12rem; padding: 3rem; background: var(--cinder-surface-raised);"
    >
      Architecture diagram
    </div>
  {/snippet}
</ZoomPanViewer>
```

The viewer starts at `scale={1}` and owns pointer and keyboard transforms for its child. `ariaLabel` names the viewport; it does not describe the diagram itself, so give the child or surrounding content a meaningful description as well. Use `onTransformChange` when the host needs to persist or mirror `{ scale, x, y }`. A failed diagram renderer should remain inside the viewport with an actionable error state—the viewer cannot retry a renderer it does not own.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `ariaLabel` | `string` | no | — | Names the viewport. Does not describe the diagram itself. |
| `class` | `string` | no | — | Additional class merged with the component's root class. |
| `scale` | `number` | no | `1` | Starting zoom scale. Defaults to `1`. |
| `children` | `(opaque)` | yes | — | Content the viewer pans and zooms. Not expressible in JSON Schema; see the component types for the signature. |
| `onTransformChange` | `(opaque)` | no | — | Called with `{ scale, x, y }` whenever the pan or zoom transform changes, for hosts that persist or mirror it. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->
