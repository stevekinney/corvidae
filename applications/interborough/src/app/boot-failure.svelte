<script lang="ts">
  /**
   * What the application shows when the host does not recognize the session. The host answers
   * every request as the one local caller, so there is nothing to sign in to: the only recovery is
   * to reload, and if that does not help, to restart Interborough.
   */
  import { ErrorState } from '@lostgradient/cinder';
</script>

<main class="weft-shell-boot-failure" data-state="error" data-view="boot">
  <ErrorState
    title="Interborough could not identify you"
    description="The host did not recognize this session. Reload the page; if it persists, restart Interborough."
    headingLevel={1}
    retryLabel="Reload"
    onRetry={() => window.location.reload()}
  />
</main>
