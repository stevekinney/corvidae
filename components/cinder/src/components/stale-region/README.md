# StaleRegion

<!-- generated:a11y-record:required -->

`StaleRegion` wraps a page (or a part of one) that keeps showing old data while the server cannot answer. It changes nothing about how that data looks: text, dots and tones stay exactly as they were, at full contrast, never dimmed with opacity. The warning banner above it is the only sign it is old. What the region does is turn off the controls that change something, and only those.

A control opts in with `mutating`, on `Button`, `Toggle`, `Checkbox`, `Select` and `DropdownTrigger`. While the region is stale an opted-in control goes inert: it carries `aria-disabled="true"`, stays focusable so a keyboard or screen-reader user can still land on it and hear why, ignores the press, and lists the region's reason in `aria-describedby` ("Off until it’s back" unless the page words its own). Everything that does not opt in stays live: links, tabs, filters, search, Retry now and Cancel. A control outside any region is untouched. When `stale` turns false the controls return by themselves, with no remount.

The region takes no box of its own (`display: contents`), so wrapping a header, a banner and a list does not move any of them.

## What it does not do

- It does not draw the banner. Put a `Banner` with a connection preset inside the region; the banner names the "as of" time with its zone once, so no row repeats it.
- It does not choose between the old data and the full error state. A page that has data shows the data under the banner; a page with nothing to show renders the error state instead. Never both.
- It does not say which controls change something. That is the page's call: mark the pencil, the trash and the "+" with `mutating`, and leave Export, which only reads, without it. New chat creates a new chat rather than editing the list, so it stays live.

## Usage

```svelte
<script lang="ts">
  import { Banner, Button, Link, StaleRegion } from '@lostgradient/cinder';

  let reachable = $state(false);
</script>

<StaleRegion stale={!reachable} reason="Off until storage answers.">
  {#if !reachable}
    <Banner preset="unreachable" dataUpdatedAt={new Date()} onRetry={() => (reachable = true)} />
  {/if}
  <Button mutating iconOnly aria-label="New agent">+</Button>
  <Link href="/agents/tool-runner">Tool runner</Link>
</StaleRegion>
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Custom class merged with `.cinder-stale-region`. |
| `describedBy` | `string` | no | — | The id of an element that already says why, such as the page's banner. Inert controls list it in `aria-describedby` instead of the region's own reason, which is then not rendered. |
| `reason` | `string` | no | `"Off until it’s back"` | The reason an inert control is off, read as its description. Pages word it for what they show: "Off until storage answers", "Approving is off until Interborough is reachable". |
| `stale` | `boolean` | no | `true` | Whether the data under the region is old. While it is, every control inside that opted in with `mutating` goes inert; when it turns false they return by themselves. Defaults to `true`, so a page mounts the region only while it is stale or binds this to its connection state. |
| `children` | `(opaque)` | yes | — | The page or section whose data may be old. Not expressible in JSON Schema; see the component types for the signature. |

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
