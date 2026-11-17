# DisclosureTrigger

The one trigger for folded content: a 14px chevron in the muted text colour at the inline start, pointing at its words and turning down when the region it shows opens, with the words at the medium weight. Board row X3 asks every disclosure on a surface to read as one control, so a step group's toggle, a reasoning block, a receipt's details and an error's details all use it. The region lives wherever the layout needs it; the trigger names it with `controls`.

## Usage

```svelte
<script lang="ts">
  import { DisclosureTrigger } from '@lostgradient/cinder';

  let open = $state(false);
</script>

<DisclosureTrigger {open} controls="refund-details" onclick={() => (open = !open)}>
  Details
</DisclosureTrigger>
{#if open}
  <div id="refund-details">Refunded $42.00 to the card ending 4471.</div>
{/if}
```

A trigger that should reach across its row, such as a step group's summary, takes a class that sets its width; its words can hold more than text, such as a count and a duration a gap apart.

Use [Collapsible](../collapsible/README.md) when the trigger and its region are one self-contained block, and [Accordion](../accordion/README.md) for sections where opening one closes the others.

## Accessibility

- A native `<button type="button">` with `aria-expanded` from `open` and `aria-controls` from `controls`; the chevron is decorative. See [`disclosure-trigger.a11y.md`](./disclosure-trigger.a11y.md).
- On a touch screen a 44px hit area that takes no layout reaches past the painted trigger.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional class names merged with `.cinder-disclosure-trigger`. |
| `controls` | `string` | no | — | The id of the region the trigger shows and hides, for `aria-controls`. |
| `open` | `boolean` | yes | — | Whether the region the trigger shows is open. |
| `children` | `(opaque)` | yes | — | The trigger's words, and anything that reads with them, such as a count or a duration. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->
<!-- generated:subcomponents:end -->
