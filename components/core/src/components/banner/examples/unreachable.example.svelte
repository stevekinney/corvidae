<script lang="ts" module>
  export const title = 'Unreachable preset';
  export const description =
    'The server is down: the preset writes the sentence, the absolute as-of time, the countdown and Retry now.';
</script>

<script lang="ts">
  import { Banner } from '@lostgradient/cinder';

  let loadedAt = new Date(Date.now() - 120_000);
  let seconds = $state(4);
</script>

<Banner
  preset="unreachable"
  dataUpdatedAt={loadedAt}
  retryInSeconds={seconds}
  attempt={3}
  onRetry={() => (seconds = 4)}
/>
