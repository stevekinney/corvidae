<script lang="ts">
  import { ResizablePanels, type ResizablePanelDefinition } from '@lostgradient/cinder';

  const panes = [
    {
      id: 'sidebar',
      label: 'Sidebar',
      defaultSize: { value: 28, unit: 'percent' },
      minSize: { value: 180, unit: 'px' },
    },
    { id: 'editor', label: 'Editor', defaultSize: { value: 72, unit: 'percent' } },
  ] satisfies ResizablePanelDefinition[];
</script>

<ResizablePanels {panes} class="resizable-panels-fixture-frame">
  {#snippet children(pane)}
    <div class="padding-block-4 padding-inline-4">{pane.label}</div>
  {/snippet}
</ResizablePanels>

<style>
  :global(.resizable-panels-fixture-frame) {
    min-block-size: 18rem;
    border: 1px solid var(--cinder-border);
  }
</style>
