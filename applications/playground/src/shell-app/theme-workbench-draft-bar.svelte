<script lang="ts">
  /*
   * The draft's controls and states: undo and redo (buttons and Mod+Z / Mod+Shift+Z, which
   * leave an editing text control to the browser's own undo), reset at category, color mode
   * and theme scope, the history-limit notice, the download action for a storage failure,
   * unreadable stored records, and the other-tab conflict with its two choices.
   */
  import { Button, Callout, ConfirmDialog } from '@lostgradient/cinder';
  import { onMount } from 'svelte';

  import { catalogueRowByPath } from './theme-builder-catalogue.ts';
  import type { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
  import { shouldDeferUndoToNative } from './theme-history.ts';
  import type { ThemeWorkbenchState } from './theme-workbench-state.svelte.ts';

  type Props = { controller: ThemeBuilderController; workbench: ThemeWorkbenchState };
  let { controller, workbench }: Props = $props();

  let confirmReload = $state(false);

  const selected = $derived(catalogueRowByPath(workbench.selectedTokenPath));
  const categoryPrefix = $derived(selected?.path.split('.')[0] ?? null);
  const notice = $derived(workbench.storageNotice);
  const canDownload = $derived(notice?.actions.includes('download') ?? false);
  const limit = $derived(controller.history?.limitNotice ?? false);

  function onKeydown(event: KeyboardEvent): void {
    const mod = event.metaKey || event.ctrlKey;
    if (!mod || event.altKey) return;
    const key = event.key.toLowerCase();
    const redo = (key === 'z' && event.shiftKey) || (key === 'y' && !event.metaKey);
    const undo = key === 'z' && !event.shiftKey;
    if (!undo && !redo) return;
    if (shouldDeferUndoToNative(document.activeElement)) return;
    event.preventDefault();
    void (redo ? controller.redo() : controller.undo());
  }

  onMount(() => {
    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  });
</script>

<div class="bar" data-testid="draft-bar">
  {#if controller.ready && controller.draftValues.size > 0}
    <span data-testid="draft-ready" hidden></span>
  {/if}
  <div class="bar__row" role="group" aria-label="History and reset">
    <Button
      label="Undo"
      variant="secondary"
      size="sm"
      disabled={!controller.canUndo}
      title={controller.undoLabel === null ? undefined : `Undo ${controller.undoLabel}`}
      onclick={() => void controller.undo()}
    />
    <Button
      label="Redo"
      variant="secondary"
      size="sm"
      disabled={!controller.canRedo}
      title={controller.redoLabel === null ? undefined : `Redo ${controller.redoLabel}`}
      onclick={() => void controller.redo()}
    />
    <Button
      label="Reset category"
      variant="secondary"
      size="sm"
      disabled={categoryPrefix === null}
      onclick={() =>
        categoryPrefix !== null &&
        void controller.reset(
          { kind: 'category', prefix: categoryPrefix },
          `Reset category ${categoryPrefix}`,
        )}
    />
    <Button
      label={`Reset ${workbench.context.colorMode} mode`}
      variant="secondary"
      size="sm"
      onclick={() =>
        void controller.reset(
          { kind: 'color-mode', colorMode: workbench.context.colorMode },
          `Reset ${workbench.context.colorMode} mode`,
        )}
    />
    <Button
      label="Reset theme"
      variant="secondary"
      size="sm"
      onclick={() => void controller.reset({ kind: 'theme' }, 'Reset theme')}
    />
    {#if canDownload}
      <Button
        label="Download theme"
        variant="secondary"
        size="sm"
        onclick={() => controller.downloadActive()}
      />
    {/if}
  </div>

  {#if workbench.previewIsLastValid}
    <p class="bar__stale" data-testid="stale-preview">
      The preview shows the last valid revision. Some input has not been applied yet.
    </p>
  {/if}

  {#if limit}
    <div data-testid="history-limit-notice">
      <Callout variant="info" title="History limit reached">
        <p>Only the 200 most recent changes can be undone. The oldest were dropped.</p>
        <Button
          label="Dismiss"
          variant="secondary"
          size="sm"
          onclick={() => controller.dismissHistoryNotice()}
        />
      </Callout>
    </div>
  {/if}

  {#if controller.conflict !== null}
    <div data-testid="conflict-notice">
      <Callout variant="warning" title="Another tab changed this draft">
        <p>{controller.conflict.message}</p>
        <Button
          label="Reload stored version"
          variant="secondary"
          size="sm"
          onclick={() => (confirmReload = true)}
        />
        <Button
          label="Save as copy"
          variant="secondary"
          size="sm"
          onclick={() => void controller.saveConflictAsCopy()}
        />
      </Callout>
    </div>
  {/if}

  {#each controller.problems as problem (problem.id)}
    <div data-testid="storage-problem">
      <Callout variant="warning" title="A stored theme could not be opened">
        <p>{problem.message}</p>
        <Button
          label="Download stored theme"
          variant="secondary"
          size="sm"
          onclick={() => controller.downloadProblem(problem)}
        />
      </Callout>
    </div>
  {/each}
</div>

<ConfirmDialog
  open={confirmReload}
  title="Reload stored version?"
  description={controller.conflict === null
    ? ''
    : controller.reloadDiscardCopy(controller.conflict.id)}
  confirmLabel="Discard and reload"
  destructive
  onConfirm={() => {
    confirmReload = false;
    void controller.reloadStoredVersion();
  }}
  onCancel={() => (confirmReload = false)}
/>

<style>
  .bar {
    display: grid;
    gap: 8px;
    min-width: 0;
  }
  .bar__row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .bar__stale {
    margin: 0;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-muted);
  }
</style>
