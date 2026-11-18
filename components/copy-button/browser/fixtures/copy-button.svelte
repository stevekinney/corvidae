<script lang="ts">
  import { default as CopyButton } from '@lostgradient/copy-button/components/copy-button/index.ts';
</script>

<div class="example-preview-row" style="align-items: center;">
  <code
    style="padding: 0.25rem 0.5rem; background-color: var(--cinder-surface-inset); color: var(--cinder-text-default); border-radius: 4px;"
    >npx cinder install</code
  >
  <CopyButton value="npx cinder install" label="Copy install command" />
  <CopyButton value="npx cinder install" label="Copy install command" textVisible />
</div>
