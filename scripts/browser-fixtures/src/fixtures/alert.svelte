<script lang="ts">
  import { Alert } from '@lostgradient/cinder';
  let dismissed = $state(false);
</script>

{#if !dismissed}
  <Alert variant="info" dismissible onDismiss={() => (dismissed = true)}>
    You have 3 unread notifications.
  </Alert>
{:else}
  <p class="note text-muted">Alert dismissed.</p>
{/if}

<style>
  .note {
    font-style: italic;
  }
</style>
