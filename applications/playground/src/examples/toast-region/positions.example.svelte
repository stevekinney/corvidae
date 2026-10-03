<script lang="ts" module>
  export const title = 'Positions';
  export const description = 'Anchor the toast region to any viewport corner or horizontal center.';
</script>

<script lang="ts">
  import { Button, type ToastPosition, ToastRegion, useToast } from '@lostgradient/cinder';

  const positions: ToastPosition[] = [
    'top-left',
    'top-center',
    'top-right',
    'bottom-left',
    'bottom-center',
    'bottom-right',
  ];

  let position: ToastPosition = $state('bottom-right');
</script>

<ToastRegion {position}>
  {#snippet children()}
    {@const toast = useToast()}
    <div class="example-preview-row">
      {#each positions as nextPosition}
        <Button
          size="sm"
          variant={position === nextPosition ? 'primary' : 'secondary'}
          label={nextPosition}
          onclick={() => {
            position = nextPosition;
            toast.show(`Position: ${nextPosition}`, { id: 'position-demo' });
          }}
        />
      {/each}
    </div>
  {/snippet}
</ToastRegion>
