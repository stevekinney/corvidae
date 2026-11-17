<script lang="ts" module>
  export const title = 'Lines and card';
  export const description =
    'lines stacks text bars; variant="card" draws a heading bar and lines inside a card.';
</script>

<script lang="ts">
  import { Skeleton } from '@lostgradient/cinder';
</script>

<div style="display: grid; gap: 1.5rem; max-inline-size: 24rem;">
  <Skeleton lines={4} />
  <Skeleton variant="card" lines={3} />
</div>
