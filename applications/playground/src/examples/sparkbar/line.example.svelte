<script lang="ts" module>
  export const title = 'Trend line';
  export const description =
    'Pass points to draw the shape of a metric over a window: a thin line over a baseline, a dot on the latest value, and a label at each end. The label is the accessible name and is not drawn.';
</script>

<script lang="ts">
  import { Sparkbar } from '@lostgradient/cinder';
</script>

<div style="max-width: 22rem;">
  <Sparkbar
    points={[1.4, 1.42, 1.45, 1.49, 1.53, 1.57, 1.6, 1.62]}
    label="Storage use over the last 24 hours, rising to 1.6 GB"
    startLabel="1.4 GB · 24 hours ago"
    endLabel="Now"
  />
</div>
