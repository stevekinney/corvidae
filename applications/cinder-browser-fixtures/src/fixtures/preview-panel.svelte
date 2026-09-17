<script lang="ts">
  import { PreviewPanel } from '@repo/cinder';
</script>

<PreviewPanel title="Artifact preview" status="ready">
  <p>Preview content is ready.</p>
  {#snippet footer()}
    <small>Updated just now</small>
  {/snippet}
</PreviewPanel>
