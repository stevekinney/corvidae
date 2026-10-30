# Skeleton

Animated placeholder shape that fills content areas while data is loading.

## Usage

```svelte
<script lang="ts">
  import { Skeleton } from '@lostgradient/cinder';
</script>

<Skeleton />
```

### Lines and variants

`lines` stacks text bars, and the last bar is shorter unless you pass `width`. `variant="card"` draws a heading bar and the lines inside a bordered card. Both match the real layout, so the page does not shift when content arrives:

```svelte
<script lang="ts">
  import { Skeleton } from '@lostgradient/cinder';
</script>

<Skeleton lines={4} />
<Skeleton variant="card" lines={3} />
```

### Loading rules

Cinder's loading rules are timing rules, and Skeleton implements them so each view does not rebuild them:

- Show nothing for the first 300 ms, so a fast load never flashes a placeholder (`delay={300}`).
- Show the skeleton in the real layout until 10 seconds have passed.
- After 10 seconds, add a "Still loading" status with a Cancel button (`stillLoadingAfter={10000}` and `onCancel`).

```svelte
<script lang="ts">
  import { Skeleton } from '@lostgradient/cinder';

  let loading = $state(true);
</script>

{#if loading}
  <Skeleton lines={5} delay={300} stillLoadingAfter={10000} onCancel={() => (loading = false)} />
{/if}
```

Both timers start when the Skeleton mounts, so render it only while the request is pending and unmount it when the request settles. Unmounting clears the timers. `stillLoadingAfter` counts from mount, not from the end of `delay`. Without `delay` or `stillLoadingAfter` a Skeleton renders immediately and never shows a status, exactly as a plain block always has.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `cancelLabel` | `string` | no | `"Cancel"` | Label of the Cancel button in the "Still loading" status. |
| `class` | `string` | no | — | Additional class merged onto the root element: `.cinder-skeleton` for a single block, or `.cinder-skeleton-group` when `lines`, `variant`, or `stillLoadingAfter` render a group. |
| `delay` | `number` | no | `0` | Milliseconds to wait after mounting before anything renders. A load that finishes inside the delay never flashes a placeholder. Use `300` for the Cinder loading rule. |
| `height` | `string` | no | — | CSS height value applied as an inline style on the skeleton block (e.g. `'1rem'`, `'48px'`). |
| `lines` | `number` | no | `1` | Number of text bars to stack. More than one renders a group, and the last bar is shorter unless `width` is set. Clamped to between 1 and 20. |
| `radius` | `string` | no | — | CSS border-radius value applied as an inline style, overriding the default pill shape (e.g. `'4px'`, `'50%'`). |
| `stillLoadingAfter` | `number` | no | — | Milliseconds after mounting at which a "Still loading" status replaces silence, with a Cancel button when `onCancel` is set. Counted from mount, not from the end of `delay`. Use `10000` for the Cinder loading rule. Omit to never show the status. |
| `stillLoadingLabel` | `string` | no | `"Still loading…"` | Text of the "Still loading" status. |
| `variant` | `"row"` \| `"card"` | no | `"row"` | Shape of the group. `'row'` stacks the bars directly; `'card'` wraps a heading bar and the `lines` bars in a bordered card. |
| `width` | `string` | no | — | CSS width value applied as an inline style on the skeleton block (e.g. `'200px'`, `'100%'`). |
| `onCancel` | `(opaque)` | no | — | Called when the Cancel button in the "Still loading" status is pressed. The button renders only when this is set. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
