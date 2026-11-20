<script lang="ts">
  import { CopyButton } from '@lostgradient/cinder';
</script>

<div class="example-preview-row example-preview-row-layout">
  <code class="code background-surface-inset text-default rounded-small">npx cinder install</code>
  <CopyButton value="npx cinder install" label="Copy install command" />
  <CopyButton value="npx cinder install" label="Copy install command" textVisible />
</div>

<style>
  .example-preview-row-layout {
    align-items: center;
  }

  .code {
    padding: var(--cinder-space-1) var(--cinder-space-2);
  }
</style>
