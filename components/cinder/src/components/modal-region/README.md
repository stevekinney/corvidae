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

The region owns a scoped modal queue and is safe to mount during SSR; `useModal()` must run inside the region's subtree. `openModal` returns a promise that settles when the modal resolves, while `confirm` provides the binary decision preset. Mount one region at the application boundary that owns the queue. When the region is destroyed, pending ordinary modals resolve to `undefined` and confirmations resolve to `false`; handle those dismissal results before applying a change.
