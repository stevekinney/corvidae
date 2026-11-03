<script lang="ts" module>
  export const title = 'Retry status and a second action';
  export const description =
    'The retry is the page’s only primary action; a secondary action, a progress line and the fault code behind a disclosure sit with it.';
</script>

<script lang="ts">
  import { Button, ErrorState } from '@lostgradient/cinder';
</script>

<ErrorState
  title="Couldn’t load runs"
  description="Interborough didn’t answer. Your runs are safe; they’re stored on this machine."
  retryStatus="Retrying in 8 s (attempt 3 of 8)"
  retryLabel="Retry now"
  detail="HTTP 500 from /api/runs"
  onRetry={() => {}}
>
  {#snippet secondaryAction()}
    <Button variant="secondary" label="Open Health" />
  {/snippet}
</ErrorState>
