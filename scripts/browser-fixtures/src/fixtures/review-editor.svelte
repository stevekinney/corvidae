<script lang="ts">
  import { Button, Segment, SegmentedControl } from '@corvidae/cinder';
  import { ReviewEditor } from '@corvidae/editor';

  type View = 'editor' | 'diff' | 'summary';
  let value = $state<View>('editor');
  let singleViewValue = $state('# Single view\n\nThis editor has no comparison document.');
  let frontMatterId = $state('review-editor-front-matter-primary');
  let frontMatterValue = $state(`---
title: Launch notes
status: draft
---

# Launch notes

The document body remains available when front matter is collapsed.`);
  let secondFrontMatterValue = $state(`---
title: Independent notes
---

# Independent notes

This instance keeps its own collapsed state.`);
  const typedFrontMatterDocument = `---
title: Launch notes
priority: 2
published: false
tags:
  - alpha
  - alpha
  - beta
metadata:
  owner: platform
  nested:
    count: 2
steps:
  - name: draft
    done: false
optional:
---

# Typed front matter

Typed controls update only their own keys.`;
  let typedFrontMatterValue = $state(typedFrontMatterDocument);
  let readonlyTypedFrontMatterValue = $state(typedFrontMatterDocument);
  let malformedFrontMatterValue = $state(`---
owner: [
---

# Malformed front matter

This leading fence must stay byte-identical.`);
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

  function changeFrontMatterId(): void {
    frontMatterId =
      frontMatterId === 'review-editor-front-matter-primary'
        ? 'review-editor-front-matter-secondary'
        : 'review-editor-front-matter-primary';
  }
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

<div id="review-editor-front-matter">
  <Button onclick={changeFrontMatterId}>Change front matter id</Button>
  <ReviewEditor id={frontMatterId} bind:value={frontMatterValue} currentUserId="steve" />
</div>

<div id="review-editor-front-matter-independent">
  <ReviewEditor
    id="review-editor-front-matter-independent-editor"
    bind:value={secondFrontMatterValue}
    currentUserId="steve"
  />
</div>

<div id="review-editor-front-matter-typed">
  <ReviewEditor
    id="review-editor-front-matter-typed-editor"
    bind:value={typedFrontMatterValue}
    currentUserId="steve"
  />
  <pre data-testid="typed-front-matter-value">{typedFrontMatterValue}</pre>
</div>

<div id="review-editor-front-matter-readonly">
  <ReviewEditor
    id="review-editor-front-matter-readonly-editor"
    bind:value={readonlyTypedFrontMatterValue}
    mode="readonly"
  />
</div>

<div id="review-editor-front-matter-malformed">
  <ReviewEditor
    id="review-editor-front-matter-malformed-editor"
    bind:value={malformedFrontMatterValue}
    currentUserId="steve"
  />
  <pre data-testid="malformed-front-matter-value">{malformedFrontMatterValue}</pre>
</div>
