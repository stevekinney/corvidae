<script lang="ts">
  import { default as ZoomPanViewer } from '@lostgradient/zoom-pan-viewer/components/zoom-pan-viewer/index.ts';
</script>

<ZoomPanViewer ariaLabel="Architecture diagram">
  {#snippet children()}
    <div
      style="min-width: 36rem; min-height: 12rem; padding: 3rem; background: var(--cinder-surface-raised);"
    >
      Architecture diagram
    </div>
  {/snippet}
</ZoomPanViewer>
