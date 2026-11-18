<script lang="ts" module>
  export const title = 'Undo toast';
  export const description =
    'An Undo toast stays until the person presses Undo or leaves the page, and has no close button, so Undo is not lost to a stray click. Other toasts dismiss themselves. Call dismissUndo() when the page changes.';
</script>

<script lang="ts">
  import { Button, ToastRegion, useToast } from '@lostgradient/cinder';
  let restored = $state(0);
</script>

<ToastRegion>
  {#snippet children()}
    {@const toast = useToast()}
    <div class="example-preview-row">
      <Button
        label="Forget a memory"
        onclick={() => toast.show('Memory forgotten.', { undo: () => (restored += 1) })}
      />
      <Button variant="secondary" label="Leave the page" onclick={() => toast.dismissUndo()} />
    </div>
    <p style="margin-top: 0.75rem; font-size: 0.875rem;">Restored: {restored}</p>
  {/snippet}
</ToastRegion>
