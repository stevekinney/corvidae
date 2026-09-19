<script lang="ts">
  import { Segment, SegmentedControl } from '@corvidae/cinder';
  import { ReviewEditor } from '@corvidae/editor';

  type View = 'editor' | 'diff' | 'summary';
  let value = $state<View>('editor');
  let singleViewValue = $state('# Single view\n\nThis editor has no comparison document.');
  const original = `# Release Plan

The first release includes a dashboard, export actions, and inline review.

## Checklist

- Finalize the component API
- Add playground coverage
- Verify consumer fixtures`;
  let geometryValue = $state(`# Release Plan

The first release includes a dashboard, export actions, inline review, and comment summaries.

## Checklist

- Finalize the component API
- Add playground coverage
- Verify consumer fixtures
- Document review export behavior`);
</script>

<div class="review-editor-controls">
  <SegmentedControl
    id="review-editor-view-switcher"
    variant="tablist"
    density="toolbar"
    selectionMode="single"
    bind:value
    label="Review view"
    class="review-editor-view-switcher"
  >
    <Segment value="editor">Editor</Segment>
    <Segment value="diff">Diff</Segment>
    <Segment value="summary">Summary</Segment>
  </SegmentedControl>
</div>

<div id="review-editor-single-view">
  <ReviewEditor id="review-editor-single" bind:value={singleViewValue} mode="readonly" />
</div>

<div id="review-editor-geometry">
  <ReviewEditor
    id="review-editor-geometry-editor"
    {original}
    bind:value={geometryValue}
    currentUserId="steve"
    snapshotMode
  />
</div>
