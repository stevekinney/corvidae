<script lang="ts">
  import { Alert } from '@corvidae/cinder';
  let dismissed = $state(false);
</script>

{#if !dismissed}
  <Alert variant="info" dismissible onDismiss={() => (dismissed = true)}>
    You have 3 unread notifications.
  </Alert>
{:else}
  <p style="color: var(--cinder-text-muted); font-style: italic;">Alert dismissed.</p>
{/if}
