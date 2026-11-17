# MapLegend

<!-- generated:a11y-record:required -->

`MapLegend` is the key to a map's marker states, each drawn in the marker's own shape so colour is never the only signal. Under the key it always renders the map attribution. Left unset, the attribution is the OpenStreetMap and ODbL credit; pass an `attribution` snippet to name a different basemap's credit. Every map surface must render it.

## Usage

```svelte
<script lang="ts">
  import { MapLegend } from '@lostgradient/cinder';
</script>

<MapLegend
  label="Map key"
  items={[
    { state: 'live', label: 'Happy hour now' },
    { state: 'idle', label: 'Starts later' },
  ]}
/>
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Custom class merged with `.cinder-map-legend`. |
| `label` | `string` | no | — | Accessible name of the legend, such as "Map key". Left unset, the legend is unnamed. |
| `attribution` | `(opaque)` | no | — | Replaces the attribution text. It is always rendered; leave it unset for the OpenStreetMap and ODbL credit. Not expressible in JSON Schema; see the component types for the signature. |
| `items` | `(opaque)` | yes | — | The marker states the map uses, in reading order. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## Authoring checklist

<!-- generated:authoring:start -->
<!-- generated:authoring:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->
<!-- generated:subcomponents:end -->
