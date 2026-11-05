# Meter

Bounded measurement gauge for fluctuating values like battery, quota, CPU, and memory usage.

Use `Meter` for static measurements with known bounds (`role="meter"`). Use `Progress` for task completion over time (`role="progressbar"`).

## Usage

```svelte
<script lang="ts">
  import { Meter } from '@lostgradient/cinder';
</script>

<Meter value={52} ariaLabel="Battery level" />
```

For a measurement that has no numeric reading, provide an `unknown` verdict. Its label is rendered next to the empty track and included in the status's accessible name. Known verdict levels keep `role="meter"`, the numeric fill, and expose the verdict label through `aria-valuetext`.

```svelte
<Meter verdict={{ level: 'unknown', label: 'Awaiting data' }} ariaLabel="Service health" />
```

To break a reading into named shares, pass `segments`. The shares stack from the start of the track, each a lighter tone of the accent, and a legend beneath the track names every share with its amount, so the tones never carry the meaning alone. `remainder` adds a last legend line for the unfilled track. The reading is the sum of the shares, so `value` is ignored.

```svelte
<script lang="ts">
  import { Meter } from '@lostgradient/cinder';
</script>

<Meter
  max={200_000}
  segments={[
    { label: 'Instructions and tools', value: 28_000, valueLabel: '28K' },
    { label: 'Conversation', value: 33_000, valueLabel: '33K' },
    { label: 'Tool results', value: 15_000, valueLabel: '15K' },
  ]}
  remainder={{ label: 'Free', valueLabel: '124K' }}
  ariaLabel="Context"
  ariaValueText="76K of 200K tokens"
/>
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `ariaLabel` | `string` | no | — | Accessible name applied directly to the meter element when no visible label element is present. |
| `ariaLabelledby` | `string` | no | — | Id of a visible element that serves as the accessible name for the meter. Prefer this when a visible label exists. |
| `ariaValueText` | `string` | no | — | Human-readable text exposed via `aria-valuetext`. When omitted, `aria-valuetext` is not rendered. Example: `50% (6 hours remaining)`. |
| `class` | `string` | no | — | Additional class names merged with `.cinder-meter`. |
| `high` | `number` | no | — | Upper threshold boundary for segmented rendering. |
| `low` | `number` | no | — | Lower threshold boundary for segmented rendering. |
| `max` | `number` | no | — | Upper bound for the range. Defaults to 100. |
| `min` | `number` | no | — | Lower bound for the range. Defaults to 0. |
| `optimum` | `number` | no | — | Optimal target value. Influences computed state semantics to match native meter expectations. |
| `remainder` | { label: `string`; valueLabel?: `string` } | no | — | With `segments`, adds a last legend line for the unfilled track, such as "Free 124K". |
| `segments` | { label: `string`; value: `number`; valueLabel?: `string` }[] | no | — | Splits the filled part of the track into named shares and lists them in a legend beneath it, such as the instructions, conversation and tool results that make up a context window. The shares stack from the start of the track in the order given, each a lighter tone of the accent, so the legend carries the meaning and colour never has to. The reading is their sum, so `value` is ignored, and threshold regions are not drawn. |
| `size` | `"sm"` \| `"md"` \| `"lg"` | no | — | Size token for track height. Default `md`. |
| `value` | `number` | no | — | Current measurement value. Defaults to 0. |
| `verdict` | { label: `string`; level: `"low"` \| `"optimum"` \| `"high"` \| `"unknown"` } | no | — | Semantic label for a measurement; `unknown` represents the non-numeric status case. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->
<!-- generated:subcomponents:end -->
