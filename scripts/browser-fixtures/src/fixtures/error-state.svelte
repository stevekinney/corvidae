<script lang="ts">
  import { ErrorState } from '@lostgradient/cinder';

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
