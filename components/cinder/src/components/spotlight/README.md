# Spotlight

<!-- generated:a11y-record:required -->

`Spotlight` is the one focal value of a screen, such as "Ends in 45 min" or "2 need you". It is set at display size in the default text colour, never the accent, which is reserved for actions.

Show liveness with `status` and `statusLabel`, which draw a status dot and word above the value. The `caveat` snippet renders at label size directly under the value and is where staleness goes ("Updated 12 min ago").

## Usage

```svelte
<script lang="ts">
  import { Spotlight } from '@lostgradient/cinder';
</script>

<Spotlight value="Ends in 45 min" status="online" statusLabel="Live">
  {#snippet caveat()}Updated 12 min ago{/snippet}
</Spotlight>
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Custom class merged with `.cinder-spotlight`. |
| `status` | `"online"` \| `"offline"` \| `"warning"` \| `"danger"` \| `"info"` \| `"pending"` \| `"neutral"` \| `"success"` \| `"accent"` | no | — | Liveness of the value, drawn as a status dot with its word above the value. Set `statusLabel` to word it. Omit both for a value with no liveness. |
| `statusLabel` | `string` | no | — | The word beside the status dot, such as "Live" or "Paused". Left unset, a `status` draws the word its tone implies. |
| `value` | `string` | yes | — | The one focal value of the screen, such as "Ends in 45 min" or "2 need you". It is set at display size in the default text colour, never the accent. |
| `caveat` | `(opaque)` | no | — | Staleness or a caution, such as "Updated 12 min ago", drawn at label size directly under the value. Not expressible in JSON Schema; see the component types for the signature. |

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
