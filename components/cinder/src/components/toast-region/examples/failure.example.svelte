<script lang="ts" module>
  export const title = 'Failure toast';
  export const description =
    'A danger toast stays until it is dismissed, shows the warning triangle, and keeps its dismiss button next to the action.';
</script>

<script lang="ts">
  import { Button, ToastRegion, useToast } from '@lostgradient/cinder';
  let attempts = $state(0);
</script>

<ToastRegion>
  {#snippet children()}
    {@const toast = useToast()}
    <Button
      variant="secondary"
      label="Export memories"
      onclick={() =>
        toast.show("Couldn't export memories", {
          variant: 'danger',
          action: { label: 'Try again', onAction: () => (attempts += 1) },
        })}
    />
    <p style="margin-top: 0.75rem; font-size: 0.875rem;">Tried again: {attempts}</p>
  {/snippet}
</ToastRegion>
