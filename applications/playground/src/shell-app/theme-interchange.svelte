<script lang="ts">
  /*
   * The toolbar's Export and Import actions (COR-486). Both stay on every pane. Each opens
   * a dialog that is mounted only while open, so the export plan and the import preflight
   * cost nothing until asked for, and focus returns to the button that opened it.
   */
  import { Button } from '@lostgradient/cinder';

  import type { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
  import ThemeExportDialog from './theme-export-dialog.svelte';
  import ThemeImportDialog from './theme-import-dialog.svelte';

  type Props = { controller: ThemeBuilderController };
  let { controller }: Props = $props();

  let exporting = $state(false);
  let importing = $state(false);
  const hasTheme = $derived(controller.draft !== null);
</script>

<div class="interchange" role="group" aria-label="Import and export">
  <Button
    label="Export"
    variant="secondary"
    disabled={!hasTheme}
    onclick={() => (exporting = true)}
    data-testid="open-export"
  />
  <Button
    label="Import"
    variant="secondary"
    disabled={!hasTheme}
    onclick={() => (importing = true)}
    data-testid="open-import"
  />
</div>

{#if exporting}
  <ThemeExportDialog {controller} open={exporting} onClose={() => (exporting = false)} />
{/if}
{#if importing}
  <ThemeImportDialog {controller} open={importing} onClose={() => (importing = false)} />
{/if}

<style>
  .interchange {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
</style>
