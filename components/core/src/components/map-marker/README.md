# MapMarker

<!-- generated:a11y-record:required -->

`MapMarker` is an anchored pin for a map you render yourself: a pill over a 10px rotated square whose point marks the place. It has four states. `live` is a filled pill with a dot, `idle` is an outlined pill that shows a start time or glyph, `selected` is raised with a ring, and `cluster` is a round count with no tail. State is never carried by colour alone, and the button is at least 44px in both directions.

`MapMarker` does not choose a map library or basemap. Position it over the map at the point its tail marks. A map that draws markers must also render `MapLegend`'s attribution.

## Usage

```svelte
<script lang="ts">
  import { MapMarker } from '@lostgradient/cinder';
</script>

<MapMarker state="idle" label="8 pm" name="Larimer Taproom, happy hour starts 8 pm" />
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Custom class merged with `.cinder-map-marker`. |
| `label` | `string` | yes | — | Visible text: a start time such as "8 pm" for an idle marker, a short word for a live one, or the count for a cluster. State is never carried by colour alone. |
| `name` | `string` | no | — | Accessible name of the marker, such as "Union Station Bar, happy hour starts 8 pm". Left unset, the label is the name and the state is appended as hidden text. |
| `state` | `"live"` \| `"idle"` \| `"selected"` \| `"cluster"` | no | — | The marker's state. `live` is a filled pill with a dot, `idle` an outlined pill, `selected` a raised pill with a ring, and `cluster` a round count with no tail. Defaults to `idle`. |
| `icon` | `(opaque)` | no | — | Decorative glyph drawn before the label. It is hidden from assistive technology. Not expressible in JSON Schema; see the component types for the signature. |

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
