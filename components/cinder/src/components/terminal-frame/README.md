# TerminalFrame

`TerminalFrame` supplies chrome, connection state, recovery UI, and character-cell resize reporting around a consumer-owned real PTY renderer. It does not implement a terminal emulator or own a transport. Resize callbacks receive `{ cols, rows }`.

Use `TerminalOutput` for read-only ANSI streams. Use `TerminalFrame` when the child content is an interactive terminal implementation whose backend needs `{ cols, rows }` resize updates.

## Usage

```svelte
<script lang="ts">
  import { TerminalFrame, type TerminalFrameDimensions } from '@corvidae/cinder';

  let dimensions = $state<TerminalFrameDimensions>({ cols: 80, rows: 24 });
</script>

<TerminalFrame
  title="Build shell"
  status="connected"
  onDimensionsChange={(nextDimensions) => (dimensions = nextDimensions)}
>
  <textarea
    aria-label="Interactive shell"
    rows={dimensions.rows}
    cols={dimensions.cols}
    value="$ bun run dev"></textarea>
</TerminalFrame>
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional class merged with the component's root class. |
| `columnWidth` | `number` | no | — | Character-cell width, in pixels, used to compute `{ cols, rows }` on resize. |
| `error` | `string` | no | — | Recovery error message. Shown with recovery UI when `status` is `error`. |
| `rowHeight` | `number` | no | — | Character-cell height, in pixels, used to compute `{ cols, rows }` on resize. |
| `status` | `"connecting"` \| `"connected"` \| `"disconnected"` \| `"error"` | no | — | Connection status shown in the frame chrome. |
| `title` | `string` | yes | — | Title shown in the frame chrome. |
| `children` | `(opaque)` | yes | — | Consumer-owned PTY renderer. Not expressible in JSON Schema; see the component types for the signature. |
| `onDimensionsChange` | `(opaque)` | no | — | Called with `{ cols, rows }` whenever the character-cell size changes, so the host can resize its PTY. Not expressible in JSON Schema; see the component types for the signature. |
| `onReloadRequest` | `(opaque)` | no | — | Called when the user requests a reload from the recovery UI shown when `status` is `error`. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->
