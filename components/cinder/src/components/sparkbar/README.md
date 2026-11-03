# Sparkbar

Compact labeled meter with a thin horizontal fill bar for inline cost, token, budget, or quota breakdowns. Given `points`, it draws the shape of a metric over a window instead: a thin line over a baseline with a dot on the latest value.

## Usage

```svelte
<script lang="ts">
  import { Sparkbar } from '@lostgradient/cinder';
</script>

<Sparkbar value={0.31} label="Draft weekly changelog" trailing="$0.31" />
```

### Trend line

Pass `points` (oldest first) to draw a line instead of a bar. `startLabel` and `endLabel` name the two ends of the window. The line is an image: `label` is its whole accessible name (a sentence such as "Storage use over the last 24 hours, rising to 1.6 GB") and is not drawn, because the card around it carries the visible title.

```svelte
<script lang="ts">
  import { Sparkbar } from '@lostgradient/cinder';
</script>

<Sparkbar
  points={[1.4, 1.42, 1.45, 1.49, 1.53, 1.57, 1.6, 1.62]}
  label="Storage use over the last 24 hours, rising to 1.6 GB"
  startLabel="1.4 GB · 24 hours ago"
  endLabel="Now"
/>
```

The line and its end dot are the accent colour (the first `theme.palette` entry overrides it). The scale runs from the series' lowest to its highest value, so the line shows shape and not magnitude; put the figure in the card. A series with fewer than two finite values draws only the baseline.

## Theming

Sparkbar inherits its foreground from `currentColor` and keeps its background transparent. The default `accent` fill uses the first resolved `--cinder-chart-series-*` color, and a partial `theme` can override that palette. The `success` and `warning` variants keep their semantic status tokens; the meter's filled position communicates magnitude independently of color.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `ariaLabel` | `string` | no | — | Accessible name override. Defaults to `${label}, ${percentage}%` for a bar, and to `label` for a line. |
| `ariaValueText` | `string` | no | — | Accessible value text override. Defaults to the trimmed trailing value when provided. |
| `class` | `string` | no | — | Custom class merged with `.cinder-sparkbar`. |
| `endLabel` | `string` | no | — | Line only: text under the right end of the baseline, such as "Now". |
| `label` | `string` | yes | — | Visible label for a bar. For a line (when `points` is given) it is the accessible name and is not drawn. |
| `max` | `number` | no | — | Upper bound for the range. Defaults to `1` for fractional values. |
| `points` | `number`[] | no | — | Draws a trend line instead of a bar: the series, oldest first, on a scale from its lowest to its highest value. Values that are not finite are skipped. |
| `size` | `"sm"` \| `"md"` \| `"lg"` | no | — | Track thickness and text scale. Default `md`. For a line, the height of the plot: 3rem, 6rem or 8rem. |
| `startLabel` | `string` | no | — | Line only: text under the left end of the baseline, such as "1.4 GB · 24 hours ago". |
| `theme` | { background?: `string`; foreground?: `string`; grid?: `string`; muted?: `string`; palette?: `string`[] } | no | — | Partial visual theme override. Omitted fields inherit the surrounding application. |
| `trailing` | `string` | no | — | Optional trailing value such as a cost, token count, or percentage. |
| `value` | `number` | no | — | Current bounded value. Required for a bar; omit it when `points` is given. |
| `variant` | `"accent"` \| `"success"` \| `"warning"` | no | — | Fill color intent. Default `accent`. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
