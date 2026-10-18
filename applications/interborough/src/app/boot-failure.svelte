<script lang="ts">
  /**
   * What the application shows when the host does not recognize the session. The host answers
   * every request as the one local caller, so there is nothing to sign in to: the only recovery is
   * to reload, and if that does not help, to restart Interborough.
   */
  import { Button, EmptyState } from '@lostgradient/cinder';
</script>

<main class="weft-shell-boot-failure" data-state="error" data-view="boot">
  <EmptyState
    title="Interborough could not identify you"
    description="The host did not recognize this session. Reload the page; if it persists, restart Interborough."
    headingLevel={1}
  >
    {#snippet action()}
      <Button variant="secondary" onclick={() => window.location.reload()}>Reload</Button>
    {/snippet}
  </EmptyState>
</main>
