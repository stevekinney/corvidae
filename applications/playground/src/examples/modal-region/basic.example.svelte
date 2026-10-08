<script lang="ts" module>
  export const title = 'Basic modal region';
  export const description = 'Mount application content inside the modal coordination region.';
</script>

<script lang="ts">
  import { Button, ModalRegion, useModal } from '@lostgradient/cinder';
</script>

<ModalRegion>
  {#snippet children()}
    {@const modal = useModal()}
    <Button onclick={() => modal.confirm({ title: 'Confirm action' })}>Open confirmation</Button>
  {/snippet}
</ModalRegion>
