# JsonViewer

Collapsible tree visualization of an arbitrary JSON value with hard depth and byte caps and a fallback for oversized payloads.

## Usage

```svelte
<script lang="ts">
  import { JsonViewer } from '@lostgradient/cinder';
</script>

<JsonViewer value={{ status: 'ok', items: [1, 2, 3] }} />
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional class names merged with `.cinder-json-viewer`. |
| `initialDepth` | `number` | no | — | Initial collapse depth. Nodes deeper than this start collapsed. Default 1. |
| `largeArrayAbove` | `number` | no | — | An array with more items than this shows its first two items followed by a muted "… N more" line, so a very large array cannot build an unbounded tree. Arrays at or under the limit show every item. Unset, every array shows every item. |
| `maxBytes` | `number` | no | — | Hard byte cap on the serialized payload. Default 1_048_576 (1 MB). |
| `maxDepth` | `number` | no | — | Hard depth cap. Nodes deeper than this never render their children. Default 50. |
| `maxKeyLength` | `number` | no | — | Longest property name shown before it is cut with an ellipsis. Unset, a name is never cut. The value is display-only: the tree holds the stored name. |
| `maxStringLength` | `number` | no | — | Longest string value shown before it is cut with an ellipsis. Unset, a value is never cut. The value is display-only: the tree holds the stored string. |
| `value` | `(opaque)` | yes | — | The value to render. Any JSON-serializable structure. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
