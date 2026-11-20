<script lang="ts">
  import { Button, ConfirmDialog } from '@lostgradient/cinder';

  let open = $state(false);
  let triggerRef: HTMLElement | null = $state(null);
  let lastAction = $state('');
</script>

<div class="example-layout gap-4">
  <Button
    label="Delete item"
    variant="danger"
    onclick={(event) => {
      triggerRef = event.currentTarget as HTMLElement;
      open = true;
    }}
  />

  {#if lastAction}
    <p class="paragraph text-muted">
      Last action: <strong>{lastAction}</strong>
    </p>
  {/if}
</div>

<ConfirmDialog
  bind:open
  {triggerRef}
  title="Delete item?"
  description="This permanently removes the item. This action cannot be undone."
  destructive
  confirmLabel="Delete"
  onConfirm={() => (lastAction = 'confirmed')}
  onCancel={() => (lastAction = 'cancelled')}
/>

<style>
  .example-layout {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
  }

  .paragraph {
    margin: 0;
    font-size: var(--cinder-text-sm);
  }
</style>
