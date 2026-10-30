<script lang="ts" module>
  export const title = 'Unreachable preset';
  export const description =
    'The server is down: a Retry action and the age of the data still shown.';
</script>

<script lang="ts">
  import { Banner } from '@lostgradient/cinder';

  let updatedAt = $state(new Date(Date.now() - 120_000));
</script>

<Banner
  preset="unreachable"
  dismissible={false}
  dataUpdatedAt={updatedAt}
  onRetry={() => (updatedAt = new Date())}
>
  Can't reach the server. Retrying in 8 seconds.
</Banner>
