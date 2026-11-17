<script lang="ts" module>
  export const title = 'Loading rules';
  export const description =
    'Nothing for 300 ms, the skeleton until 10 seconds, then Still loading with Cancel.';
</script>

<script lang="ts">
  import { Button, Skeleton } from '@lostgradient/cinder';

  let loading = $state(false);
</script>

<div style="display: grid; gap: 1rem; max-inline-size: 24rem;">
  <Button label="Start loading" onclick={() => (loading = true)} disabled={loading} />
  {#if loading}
    <Skeleton lines={5} delay={300} stillLoadingAfter={10000} onCancel={() => (loading = false)} />
  {/if}
</div>
