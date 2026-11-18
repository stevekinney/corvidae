<script lang="ts">
  import { default as PreviewPanel } from '@lostgradient/preview-panel/components/preview-panel/index.ts';
</script>

<PreviewPanel title="Artifact preview" status="ready">
  <p>Preview content is ready.</p>
  {#snippet footer()}
    <small>Updated just now</small>
  {/snippet}
</PreviewPanel>
