# ModalRegion

Mount `ModalRegion` once in a context boundary and call `useModal().openModal` or `useModal().confirm` from descendants. State is scoped to the region and safe during SSR.

## Usage

```svelte
<script lang="ts">
  import { Button } from '@corvidae/cinder';
  import { ModalRegion, useModal } from '@corvidae/cinder';
</script>

<ModalRegion>
  {#snippet children()}
    {@const modal = useModal()}
    <Button onclick={() => modal.confirm({ title: 'Confirm action' })}>Open confirmation</Button>
  {/snippet}
</ModalRegion>
```

The region owns a scoped registry of open modals, not a serializing queue, and is safe to mount during SSR; `useModal()` must run inside the region's subtree. Calling `openModal` or `confirm` again before an earlier one settles renders both concurrently—the second does not wait for the first—so coordinate at the call site if only one modal should be visible at a time. `openModal` returns a promise that settles when the modal resolves, while `confirm` provides the binary decision preset. Mount one region at the application boundary that owns this registry. When the region is destroyed, pending ordinary modals resolve to `undefined` and confirmations resolve to `false`; handle those dismissal results before applying a change.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `children` | `(opaque)` | no | — | Descendant application surface that opens modals through `useModal()`. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->
