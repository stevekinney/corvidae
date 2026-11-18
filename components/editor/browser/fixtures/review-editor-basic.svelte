<script lang="ts">
  import { ReviewEditor } from '@lostgradient/editor';

  const original = `# Release Plan

The first release includes a dashboard, export actions, and inline review.

## Checklist

- Finalize the component API
- Add playground coverage
- Verify consumer fixtures`;

  let value = $state(`# Release Plan

The first release includes a dashboard, export actions, inline review, and comment summaries.

## Checklist

- Finalize the component API
- Add playground coverage
- Verify consumer fixtures
- Document review export behavior`);
</script>

<div id="example-mount-basic" style="min-height: 34rem;">
  <ReviewEditor id="review-editor" {original} bind:value currentUserId="steve" name="review" />
</div>
