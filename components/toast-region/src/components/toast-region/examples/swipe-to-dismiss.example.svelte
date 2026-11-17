<script lang="ts" module>
  export const title = 'Swipe to dismiss';
  export const description = 'Dismiss a toast by dragging it horizontally past the threshold.';
</script>

<script lang="ts">
  import { Button } from '@lostgradient/button';
  import { ToastRegion } from '@lostgradient/toast-region';
  import { useToast } from '@lostgradient/foundation/utilities/use-toast.ts';
</script>

<ToastRegion>
  {#snippet children()}
    {@const toast = useToast()}
    <Button
      label="Show swipe toast"
      onclick={() =>
        toast.show('Drag this notification left or right to dismiss it.', {
          duration: 0,
        })}
    />
  {/snippet}
</ToastRegion>
