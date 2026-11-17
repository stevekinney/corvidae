<script lang="ts" module>
  export const title = 'Pause on hover';
  export const description =
    'Pointer hover and keyboard focus pause auto-dismiss for the whole stack.';
</script>

<script lang="ts">
  import { Button } from '@lostgradient/button';
  import { ToastRegion } from '@lostgradient/toast-region';
  import { useToast } from '@lostgradient/foundation/utilities/use-toast.ts';
</script>

<ToastRegion defaultDuration={2500}>
  {#snippet children()}
    {@const toast = useToast()}
    <Button
      label="Show timed toast"
      onclick={() =>
        toast.show('Hover or focus the stack to pause this countdown.', {
          action: {
            label: 'Keep',
            keepOpen: true,
            onAction: () => {},
          },
        })}
    />
  {/snippet}
</ToastRegion>
