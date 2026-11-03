<script lang="ts" module>
  export const title = 'Segments with counts';
  export const description =
    'A segment takes a count, drawn after the label in a muted, tabular figure. The count is part of the accessible name ("Waiting on you, 2"), and zero still shows.';
</script>

<script lang="ts">
  import { Segment, SegmentedControl } from '@lostgradient/cinder';

  let { mountIdPrefix }: { mountIdPrefix?: string } = $props();
  const uid = $props.id();
  let controlId = $derived(`${mountIdPrefix ?? uid}-playground-status`);

  let value = $state('all');
</script>

<SegmentedControl id={controlId} selectionMode="single" bind:value label="Status">
  <Segment value="all" count={19}>All</Segment>
  <Segment value="waiting" count={2}>Waiting on you</Segment>
  <Segment value="running" count={0}>Running</Segment>
  <Segment value="done" count={15}>Done</Segment>
  <Segment value="failed" count={1}>Failed</Segment>
</SegmentedControl>
