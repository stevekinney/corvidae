<script lang="ts">
  import { PreviewPanel } from '@corvidae/cinder';
</script>

<PreviewPanel title="Artifact preview" status="ready">
  <p>Preview content is ready.</p>
  {#snippet footer()}
    <small>Updated just now</small>
  {/snippet}
</PreviewPanel>
