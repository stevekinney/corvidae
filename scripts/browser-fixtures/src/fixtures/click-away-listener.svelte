<script lang="ts">
  import { Button, ClickAwayListener } from '@lostgradient/cinder';

  let open = $state(false);
</script>

<Button onclick={() => (open = true)}>Open inline editor</Button>

{#if open}
  <ClickAwayListener
    onClickAway={() => (open = false)}
    class="click-away-fixture-panel gap-3 margin-block-start-4 padding-block-4 padding-inline-4 rounded-large background-surface-raised"
  >
    <p class="paragraph">Click outside this box to dismiss it.</p>
    <Button variant="secondary" onclick={() => (open = false)}>Close</Button>
  </ClickAwayListener>
{/if}

<style>
  :global(.click-away-fixture-panel) {
    display: inline-flex;
    flex-direction: column;
    border: var(--cinder-border-width) solid var(--cinder-border);
  }

  .paragraph {
    margin: 0;
  }
</style>
