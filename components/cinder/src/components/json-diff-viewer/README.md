# JsonDiffViewer

Structural comparison of two JSON values: added, removed and changed entries at any depth, with unchanged entries collapsed and long levels paged.

## Usage

```svelte
<script lang="ts">
  import { JsonDiffViewer } from '@lostgradient/cinder';
</script>

<JsonDiffViewer
  before={{ status: 'queued', retries: 3, tags: ['etl'] }}
  after={{ status: 'running', retries: 3, tags: ['etl', 'nightly'] }}
/>
```

A panel imports the same component from `@lostgradient/cinder/panel`, beside `mountPanel`.

## How values compare

- Objects compare by key and arrays by index, to any depth up to `maxDepth`. Inserting at the front of an array shows as every later index changing.
- A value that changes type, such as a number that becomes a string or an object that becomes an array, shows as one removed entry and one added entry, never as one change.
- A changed object or array nests its own differences under its key. An added or removed one shows as a one-line size, such as `{3 keys}` or `[2 items]`.
- Each row leads with a symbol and a name besides its tint: `+` added, `-` removed, `~` changed and `=` unchanged. A changed entry reads `before → after` on one line.
- Unchanged entries start collapsed behind a control that names how many it holds.
- A level renders its first 200 entries; a control shows the next 200. Nested levels add up, so a nested level opens by default only while the first render stays under about 900 elements; one that would not starts closed behind a "Show N changes" control. A comparison of two large values therefore creates a bounded number of elements before anyone asks for more.
- Identical values render the text "No differences".
- Values that are not JSON, and circular references, are out of scope: pass what `JSON.stringify` accepts.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional class names merged with `.cinder-json-diff-viewer`. |
| `label` | `string` | no | — | The accessible name of the comparison. Default "JSON differences". |
| `maxDepth` | `number` | no | — | Hard depth cap. Collections nested deeper than this are compared whole and show as one changed entry, never walked. Default 50. |
| `after` | `(opaque)` | yes | — | The value to compare to. Any JSON-serializable structure. Not expressible in JSON Schema; see the component types for the signature. |
| `before` | `(opaque)` | yes | — | The value to compare from. Any JSON-serializable structure. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
