# ToastRegion

ToastRegion provides live toast notifications and a `useToast()` controller for descendants.

## Usage

```svelte
<script lang="ts">
  import { Button, ToastRegion, useToast } from '@lostgradient/cinder';
</script>

<ToastRegion>
  {#snippet children()}
    {@const toast = useToast()}
    <Button
      label="Show swipe toast"
      onclick={() =>
        toast.show('Drag this notification left or right to dismiss it.', {
          duration: 0,
        })}
    />
  {/snippet}
</ToastRegion>
```

## Undo, failure and the other toasts

Toasts follow one rule about how long they stay: an Undo toast stays until the person acts or leaves the page, a failure stays until it is dismissed, and everything else dismisses itself.

- **Undo**: `toast.show('Memory forgotten.', { undo: () => restore() })` shows an "Undo" action that calls the function. The toast has no timer and no close button, so the Undo is not lost to a stray click. Call `toast.dismissUndo()` when the page changes, so an Undo never outlives the page it would undo a change on.
- **Failure**: a `danger` toast has no timer, shows the warning triangle, and keeps its dismiss button. Pair it with an action: `toast.show("Couldn't export memories", { variant: 'danger', action: { label: 'Try again', onAction } })`.
- **Everything else**: `info`, `success` and `warning` toasts dismiss themselves after `defaultDuration`. "Back online. Updated just now." is one of these, not a banner, so the page does not shift twice.

An explicit `duration` or `dismissible` overrides each default.

## Where the region sits

A bottom-anchored region sits above whatever is docked to the bottom of the page and inside the bottom safe area, so a toast never covers Send or Connect a provider. Its offset is the on-screen keyboard (`--_cinder-keyboard-inset`) plus the height of a mounted [`DockedActionBar`](../docked-action-bar/README.md) (`--_cinder-docked-action-bar-height`, which already includes that bar's safe-area padding) or, with no bar, `env(safe-area-inset-bottom)`. On a phone the region spans the screen between two 12px gutters, and an action is a 44px target on touch and on a phone.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional class names merged with `.cinder-toast-region`. |
| `defaultDuration` | `number` | no | — | Default auto-dismiss duration in ms. Default 5000. Set to 0 for sticky. |
| `maxStack` | `number` | no | — | Maximum simultaneous toasts in each region. Default 5. |
| `position` | `"top-left"` \| `"top-center"` \| `"top-right"` \| `"bottom-left"` \| `"bottom-center"` \| `"bottom-right"` | no | — | Viewport anchor for both live-region channels. Default `bottom-right`. |
| `children` | `(opaque)` | no | — | Optional children. When provided, the region wraps them so descendants can call `useToast()` and read the region's context. Most apps mount `<ToastRegion>` as a self-closing tag at the root of their layout and leave this empty — but some patterns (modal-scoped regions, tests) benefit from explicit child composition. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
