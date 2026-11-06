<script lang="ts">
  /** A composer whose controls say whether the composer told them it is narrow. */
  import ChatInput from './chat-input.svelte';

  let { id }: { id: string } = $props();
</script>

<ChatInput {id}>
  {#snippet controls({ folded })}
    <span data-testid="controls">{folded ? 'folded' : 'full'}</span>
  {/snippet}
</ChatInput>
