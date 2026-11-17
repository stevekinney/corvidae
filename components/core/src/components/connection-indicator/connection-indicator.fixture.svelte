<script lang="ts">
  import { ConnectionIndicator, type ConnectionIndicatorStatus } from './index.ts';

  type FixtureProps = {
    status?: ConnectionIndicatorStatus;
  };

  let { status = 'live' }: FixtureProps = $props();
</script>

<ConnectionIndicator {status} />
