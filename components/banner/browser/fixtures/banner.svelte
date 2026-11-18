<script lang="ts">
  import { default as Banner } from '@lostgradient/banner/components/banner/index.ts';
  let visible = $state(true);
</script>

{#if visible}
  <Banner variant="info" onDismiss={() => (visible = false)}>
    Scheduled maintenance is planned.
  </Banner>
{:else}
  <p>Banner dismissed.</p>
{/if}
