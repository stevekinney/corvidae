<script lang="ts">
  import { Segment, SegmentedControl } from '@repo/cinder';

  type View = 'editor' | 'diff' | 'summary';
  let value = $state<View>('editor');
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
