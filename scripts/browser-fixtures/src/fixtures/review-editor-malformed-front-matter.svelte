<script lang="ts">
  import { ReviewEditor } from '@lostgradient/editor';

  // A fenced but unparseable front-matter block: `owner: [` is an unterminated flow sequence.
  // Same document as `review-editor-mounted-controls.test.ts`.
  let value = $state('---\nowner: [\n---\n\n# Malformed\n');
  let editor = $state<ReviewEditor>();
  let exported = $state('');
</script>

<div id="example-mount-malformed-front-matter" style="min-height: 24rem;">
  <ReviewEditor
    bind:this={editor}
    id="malformed-front-matter-editor"
    bind:value
    currentUserId="reviewer"
    name="review"
  />
  <button type="button" onclick={() => (exported = editor?.getMarkdown() ?? '')}>
    Read Markdown export
  </button>
  <pre id="malformed-front-matter-value">{value}</pre>
  <pre id="malformed-front-matter-export">{exported}</pre>
</div>
