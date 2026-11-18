<script lang="ts">
  import { default as Button } from '@lostgradient/button/components/button/index.ts';
  import {
    default as ModalRegion,
    useModal,
  } from '@lostgradient/modal-region/components/modal-region/index.ts';
</script>

<ModalRegion>
  {#snippet children()}
    {@const modal = useModal()}
    <Button onclick={() => modal.confirm({ title: 'Confirm action' })}>Open confirmation</Button>
  {/snippet}
</ModalRegion>
