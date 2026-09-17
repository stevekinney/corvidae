<script lang="ts">
  import { Banner } from '@repo/cinder';
  let visible = $state(true);
</script>

{#if visible}
  <Banner variant="info" onDismiss={() => (visible = false)}>
    Scheduled maintenance is planned.
  </Banner>
{:else}
  <p>Banner dismissed.</p>
{/if}
