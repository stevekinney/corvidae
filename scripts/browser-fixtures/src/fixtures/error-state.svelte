<script lang="ts">
  import { Button, ErrorState } from '@lostgradient/cinder';

  let retries = $state(0);
</script>

<ErrorState
  title="Could not load runs"
  description="The server did not respond in time."
  detail="E_TIMEOUT"
  onRetry={() => (retries += 1)}
/>
<p data-testid="error-state-retries">Retried {retries} times.</p>

<ErrorState
  title="You do not have access"
  description="Ask a workspace owner to grant you access to this view."
  headingLevel={3}
/>

<ErrorState
  title="Couldn’t load runs"
  description="Interborough didn’t answer. Your runs are safe; they’re stored on this machine."
  retryStatus="Retrying in 8 s (attempt 3 of 8)"
  retryLabel="Retry now"
  detail="HTTP 500 from /api/runs"
  onRetry={() => (retries += 1)}
>
  {#snippet secondaryAction()}
    <Button variant="secondary" label="Open Health" />
  {/snippet}
</ErrorState>

<ErrorState
  tone="neutral"
  title="This run doesn’t exist"
  description="It may have been deleted. The address might also be mistyped."
>
  {#snippet secondaryAction()}
    <Button variant="secondary" label="Back to Runs" />
  {/snippet}
</ErrorState>
