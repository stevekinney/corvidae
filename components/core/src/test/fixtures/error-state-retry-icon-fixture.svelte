<script lang="ts">
  import Button from '../../components/button/button.svelte';
  import ErrorState from '../../components/error-state/error-state.svelte';
</script>

{#snippet pencil()}
  <svg data-testid="pencil" viewBox="0 0 16 16"><path d="M2 14l1-4 8-8 3 3-8 8z" /></svg>
{/snippet}

{#snippet backToChats()}
  <Button variant="secondary" label="Back to chats" />
{/snippet}

<ErrorState
  tone="neutral"
  title="Chat not found"
  description="It may have been deleted."
  retryLabel="New chat"
  onRetry={() => {}}
  retryIcon={pencil}
  secondaryAction={backToChats}
/>
