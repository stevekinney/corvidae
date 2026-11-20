<script lang="ts">
  import { Button, Portal } from '@lostgradient/cinder';

  let open = $state(false);
</script>

<Button onclick={() => (open = !open)}>
  {open ? 'Hide portal' : 'Show portal'}
</Button>

{#if open}
  <Portal>
    <div
      class="example-frame padding-block-4 padding-inline-4 rounded-large background-surface-raised"
    >
      <strong>Portaled content</strong>
      <p>This surface is rendered through <code>document.body</code>.</p>
    </div>
  </Portal>
{/if}

<style>
  .example-frame {
    position: fixed;
    inset-block-end: var(--cinder-space-4);
    inset-inline-end: var(--cinder-space-4);
    max-width: 18rem;
    border: 1px solid var(--cinder-border);
    box-shadow: var(--cinder-shadow-lg);
  }
</style>
