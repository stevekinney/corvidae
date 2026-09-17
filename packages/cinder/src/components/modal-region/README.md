# ModalRegion

Mount `ModalRegion` once in a context boundary and call `useModal().openModal` or `useModal().confirm` from descendants. State is scoped to the region and safe during SSR.

## Usage

```svelte
<script lang="ts">
  import { Button } from '@repo/cinder';
  import { ModalRegion, useModal } from '@repo/cinder';
</script>

<ModalRegion>
  {#snippet children()}
    {@const modal = useModal()}
    <Button onclick={() => modal.confirm({ title: 'Confirm action' })}>Open confirmation</Button>
  {/snippet}
</ModalRegion>
```
