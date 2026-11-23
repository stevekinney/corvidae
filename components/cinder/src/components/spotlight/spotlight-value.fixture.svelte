<script lang="ts">
  import Badge from '../badge/badge.svelte';
  import Spotlight from './spotlight.svelte';
</script>

<Spotlight>
  {#snippet value()}Its last 2 runs <Badge size="sm" variant="danger">Failed</Badge>{/snippet}
</Spotlight>
