# AttemptsIndicator

<!-- generated:a11y-record:required -->

`AttemptsIndicator` draws one segment per allowed attempt and fills the segments for the attempts made: 2 of 5 draws two filled segments out of five, 5 of 5 all five, 1 of 1 one. The whole bar is a single image named "2 of 5 attempts".

It is neutral by default, because the status word beside it carries the outcome (Done, Gave up and Stopped all draw the same bar). On a goal's list row it sits on line two beside its count. Pass `tone="accent"` and `layout="block"` for a bar that is a progress cue in its own right, such as the reconnecting dialog's "Attempt 3 of 8".

## Usage

```svelte
<script lang="ts">
  import { AttemptsIndicator } from '@lostgradient/cinder';
</script>

<span>
  <AttemptsIndicator made={2} allowed={5} /> 2 of 5
</span>
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `allowed` | `number` | yes | — | Attempts allowed, which is the number of segments: one per allowed attempt. Above 100 the bar still draws 100 segments and fills them in proportion. |
| `class` | `string` | no | — | Custom class merged with `.cinder-attempts-indicator`. |
| `label` | `string` | no | — | Accessible name. Defaults to `${made} of ${allowed} attempts`. |
| `layout` | `"inline"` \| `"block"` | no | — | Width of the bar. Default `inline`. |
| `made` | `number` | yes | — | Attempts made so far. Filled segments are counted from the start; the value is clamped to `allowed`. |
| `tone` | `"neutral"` \| `"accent"` | no | — | Colour of the filled segments. `neutral` is the default, because the word beside the bar carries the outcome; `accent` suits a bar that is a progress cue in its own right, such as reconnection attempts. |

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
