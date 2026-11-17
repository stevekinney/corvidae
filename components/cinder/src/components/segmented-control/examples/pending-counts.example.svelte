<script lang="ts" module>
  export const title = 'Counts that are still loading';
  export const description =
    'count="pending" draws a dash where the number will be ("All –") and reads as "All, loading", so the segments keep their width while the data arrives.';
</script>

<script lang="ts">
  import { Segment, SegmentedControl } from '@lostgradient/cinder';

  let { mountIdPrefix }: { mountIdPrefix?: string } = $props();
  const uid = $props.id();
  let controlId = $derived(`${mountIdPrefix ?? uid}-pending-status`);

  let value = $state('all');
</script>

<SegmentedControl id={controlId} selectionMode="single" bind:value label="Status">
  <Segment value="all" count="pending">All</Segment>
  <Segment value="waiting" count="pending">Waiting on you</Segment>
  <Segment value="unavailable" count="pending">Unavailable</Segment>
</SegmentedControl>
