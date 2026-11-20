<script lang="ts">
  import { ZoomPanViewer } from '@lostgradient/cinder';
</script>

<ZoomPanViewer ariaLabel="Architecture diagram">
  {#snippet children()}
    <div class="children-div padding-block-12 padding-inline-12 background-surface-raised">
      Architecture diagram
    </div>
  {/snippet}
</ZoomPanViewer>

<style>
  .children-div {
    min-width: 36rem;
    min-height: 12rem;
  }
</style>
