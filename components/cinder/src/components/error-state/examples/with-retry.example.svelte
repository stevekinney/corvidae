<script lang="ts" module>
  export const title = 'With retry';
  export const description = 'A failed query with a fault code and a retry button.';
</script>

<script lang="ts">
  import { ErrorState } from '@lostgradient/cinder';

  let attempts = $state(0);
</script>

<ErrorState
  title="Could not load runs"
  description="The server did not respond in time."
  detail="E_TIMEOUT"
  onRetry={() => (attempts += 1)}
/>
<p>Retried {attempts} times.</p>
