<script lang="ts">
  import Button from '../../components/button/button.svelte';
  import ErrorState from '../../components/error-state/error-state.svelte';

  let { withRetry = true }: { withRetry?: boolean } = $props();
</script>

{#snippet openHealth()}
  <Button variant="secondary" label="Open Health" />
{/snippet}

{#if withRetry}
  <ErrorState
    title="Couldn’t load runs"
    description="Interborough didn’t answer."
    retryLabel="Retry now"
    onRetry={() => {}}
    secondaryAction={openHealth}
  />
{:else}
  <ErrorState
    title="Couldn’t load runs"
    description="Interborough didn’t answer."
    secondaryAction={openHealth}
  />
{/if}
