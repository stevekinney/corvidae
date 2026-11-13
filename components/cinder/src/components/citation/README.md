# Citation

<!-- generated:a11y-record:required -->

`Citation` pairs an inline source marker with a Popover of source details. Every source is one row of one list, in the order given, however many there are; there is no pager.

Each row shows the source's title (clamped to two lines), its domain in small muted text under it, and its excerpt in quotation marks when it has one. With a safe web address the whole row is the link and an open-in-new glyph ends it. Without an address the row is not a link and its muted line reads "Internal document, no public link"; with a refused address it reads "Link hidden: the address isn't a safe web link". `resolveCitationLink` applies the same policy for a host that draws sources itself. Pass `labels` to translate the words Citation draws.

The panel is as tall as its rows up to about half the viewport, then the list scrolls; on a phone it opens as a bottom sheet. Pass `current` (an index into `sources`) when the reader followed a marker for one source: that row is marked, announced as current with `aria-current`, and scrolled into view when the list opens, so a marker in the text opens the same list as any other. Pass `inPlace` to open the list under the marker on a viewport at least as wide as a phone instead of in a floating popover; `expanded` and `onExpandedChange` drive that state; on a phone the sheet is used and they are not. `markerLabel` names a marker whose children already say how many sources there are.

## Usage

```svelte
<script lang="ts">
  import { Citation } from '@lostgradient/cinder';
</script>

<Citation sources={[{ label: 'Component metadata guide', url: '/docs/components' }]} />
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Custom class merged with `.cinder-citation`. |
| `closeOnSourceRemoval` | `boolean` | no | — | Closes an open panel when a previously displayed source is withdrawn by the host. |
| `current` | `number` | no | — | The index in `sources` of the source the reader followed a marker for. Its row is marked as the current one, and the list opens scrolled to it. |
| `expanded` | `boolean` | no | — | With `inPlace`, whether the sources are open under the marker. Bindable; the marker toggles it. |
| `inPlace` | `boolean` | no | — | Opens the sources under the marker instead of in a floating popover, on a viewport at least as wide as a phone. On a phone they still open in the bottom sheet. |
| `label` | `string` | no | — | Names the marker and the panel, such as `Sources`. The marker reads it with the source count. |
| `markerLabel` | `string` | no | — | The marker's accessible name when it has sources, for a marker whose children already say how many ("3 sources"). Defaults to `label` and the count, such as "Sources (3)". |
| `children` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `labels` | `(opaque)` | no | — | The words Citation draws itself, for a host that translates them. Each one left out keeps its English default. Not expressible in JSON Schema; see the component types for the signature. |
| `onCloseComplete` | `(opaque)` | no | — | Called after an open source panel or sheet has fully closed. Not expressible in JSON Schema; see the component types for the signature. |
| `onExpandedChange` | `(opaque)` | no | — | With `inPlace`, called after the marker toggles `expanded`, with the new value. Not expressible in JSON Schema; see the component types for the signature. |
| `sources` | `(opaque)` | yes | — | The sources behind the claim, in the order to show them. Every source is one row of one list, however many there are. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## Authoring checklist

<!-- generated:authoring:start -->

Before publishing this component, complete the live [component authoring pre-flight](../../../README.md#component-authoring-checklist).
<!-- generated:authoring:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
