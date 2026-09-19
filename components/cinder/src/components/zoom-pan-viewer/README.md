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
