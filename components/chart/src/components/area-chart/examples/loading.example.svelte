<script lang="ts" module>
  export const title = 'Loading state';
  export const description = 'An area chart with reserved layout while data loads.';
</script>

<script lang="ts">
  import { AreaChart } from '@lostgradient/chart';
</script>

<AreaChart label="Loading usage" loading series={[]} />
