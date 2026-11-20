<script lang="ts">
  import { Button, FocusTrap } from '@lostgradient/cinder';

  let open = $state(false);
</script>

<Button onclick={() => (open = !open)}>
  {open ? 'Close focus trap' : 'Open focus trap'}
</Button>

{#if open}
  <FocusTrap
    class="focus-trap-fixture-panel gap-3 margin-block-start-4 padding-block-4 padding-inline-4 rounded-large background-surface-raised"
  >
    <Button variant="secondary">Cancel</Button>
    <Button>Save changes</Button>
  </FocusTrap>
{/if}

<style>
  :global(.focus-trap-fixture-panel) {
    display: inline-flex;
    border: var(--cinder-border-width) solid var(--cinder-border);
  }
</style>
