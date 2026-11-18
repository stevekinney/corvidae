<script lang="ts">
  import Button from '../button/button.svelte';
  import DockedActionBar from './docked-action-bar.svelte';

  let { off = false, reason }: { off?: boolean; reason?: string } = $props();
  let pressed = $state(0);
</script>

<DockedActionBar label="Run actions" {off} {...reason === undefined ? {} : { reason }}>
  <span>Add context</span>
  {#snippet actions()}
    <Button mutating data-testid="send" onclick={() => (pressed += 1)}>Send a message</Button>
    <span data-testid="pressed">{pressed}</span>
  {/snippet}
</DockedActionBar>
