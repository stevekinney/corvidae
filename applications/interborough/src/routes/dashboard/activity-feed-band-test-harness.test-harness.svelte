<script lang="ts">
  /** Test-only composition of the fleet-source context and `<ActivityFeedBand>`. */
  import { untrack } from 'svelte';

  import { provideFleetEventSource } from '../../app/engine-status.svelte.ts';
  import type { FleetEventSource } from '../../lib/live-source/fleet-event-source.svelte.ts';
  import ActivityFeedBand from './activity-feed-band.svelte';

  interface Props {
    source: FleetEventSource;
  }

  let { source }: Props = $props();

  provideFleetEventSource(untrack(() => source));
</script>

<ActivityFeedBand />
