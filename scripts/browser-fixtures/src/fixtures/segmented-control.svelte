<script lang="ts">
  import { Segment, SegmentedControl } from '@lostgradient/cinder';

  type View = 'source' | 'rendered' | 'diff';
  let smValue = $state<View>('rendered');
  let mdValue = $state<View>('rendered');
  let lgValue = $state<View>('rendered');
  let toolbarValue = $state<View>('rendered');
  let toolbarMdValue = $state<View>('rendered');
  let toolbarLgValue = $state<View>('rendered');
  const views = [
    { value: 'editor', label: 'Editor' },
    { value: 'diff', label: 'Diff' },
    { value: 'summary', label: 'Summary' },
  ] as const;
  let horizontalValue = $state<(typeof views)[number]['value']>('editor');
  let verticalValue = $state<(typeof views)[number]['value']>('editor');
</script>

<div style="display: grid; gap: 1rem; justify-items: start;">
  <SegmentedControl
    id="segmented-sizing-sm"
    size="sm"
    selectionMode="single"
    bind:value={smValue}
    label="size=sm"
  >
    <Segment value="source">Source</Segment><Segment value="rendered">Rendered</Segment><Segment
      value="diff"
      disabled>Diff</Segment
    >
  </SegmentedControl>
  <SegmentedControl
    id="segmented-sizing-md"
    size="md"
    selectionMode="single"
    bind:value={mdValue}
    label="size=md"
  >
    <Segment value="source">Source</Segment><Segment value="rendered">Rendered</Segment><Segment
      value="diff"
      disabled>Diff</Segment
    >
  </SegmentedControl>
  <SegmentedControl
    id="segmented-sizing-lg"
    size="lg"
    selectionMode="single"
    bind:value={lgValue}
    label="size=lg"
  >
    <Segment value="source">Source</Segment><Segment value="rendered">Rendered</Segment><Segment
      value="diff"
      disabled>Diff</Segment
    >
  </SegmentedControl>
  <SegmentedControl
    id="segmented-sizing-toolbar"
    density="toolbar"
    selectionMode="single"
    bind:value={toolbarValue}
    label="density=toolbar"
  >
    <Segment value="source">Source</Segment><Segment value="rendered">Rendered</Segment><Segment
      value="diff"
      disabled>Diff</Segment
    >
  </SegmentedControl>
  <SegmentedControl
    id="segmented-sizing-toolbar-md"
    size="md"
    density="toolbar"
    selectionMode="single"
    bind:value={toolbarMdValue}
    label="density=toolbar + size=md"
  >
    <Segment value="source">Source</Segment><Segment value="rendered">Rendered</Segment><Segment
      value="diff"
      disabled>Diff</Segment
    >
  </SegmentedControl>
  <SegmentedControl
    id="segmented-sizing-toolbar-lg"
    size="lg"
    density="toolbar"
    selectionMode="single"
    bind:value={toolbarLgValue}
    label="density=toolbar + size=lg"
  >
    <Segment value="source">Source</Segment><Segment value="rendered">Rendered</Segment><Segment
      value="diff"
      disabled>Diff</Segment
    >
  </SegmentedControl>

  <SegmentedControl
    id="segmented-tablist-horizontal"
    variant="tablist"
    selectionMode="single"
    bind:value={horizontalValue}
    label="Review view"
  >
    {#each views as view (view.value)}
      <Segment id={`segmented-tablist-${view.value}-tab`} value={view.value}>{view.label}</Segment>
    {/each}
  </SegmentedControl>
  <SegmentedControl
    id="segmented-tablist-vertical"
    variant="tablist"
    orientation="vertical"
    selectionMode="single"
    bind:value={verticalValue}
    label="Review view (vertical)"
  >
    {#each views as view (view.value)}
      <Segment id={`segmented-tablist-v-${view.value}-tab`} value={view.value}>{view.label}</Segment
      >
    {/each}
  </SegmentedControl>
</div>
