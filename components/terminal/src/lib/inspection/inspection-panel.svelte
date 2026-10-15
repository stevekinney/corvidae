<script lang="ts">
  import { Button, CopyButton, Modal, Textarea } from '@lostgradient/cinder';
  import { tick, untrack } from 'svelte';

  import type { Inspection } from './inspection-controller.ts';
  import { describeSearch, describeSnapshot } from './inspection-copy.ts';

  let {
    inspection,
    toolbarVisible,
    restoreTarget,
  }: {
    inspection: Inspection;
    /** The toolbar shows while the terminal shows a mounted engine; the dialogs outlive it. */
    toolbarVisible: boolean;
    /** Where focus goes when the control that opened a dialog is no longer mounted. */
    restoreTarget: () => HTMLElement | undefined;
  } = $props();

  let view = $state.raw(untrack(() => inspection.view));
  $effect(() => {
    view = inspection.view;
    return inspection.subscribe(() => {
      view = inspection.view;
    });
  });

  const id = $props.id();
  const searchId = `${id}-search`;
  const snapshotId = `${id}-snapshot`;

  let searchTrigger: HTMLElement | null = null;
  let exportTrigger = $state.raw<HTMLElement | null>(null);

  const searchSummary = $derived(describeSearch(view.search, view.selectionFailed));
  const notices = $derived(view.snapshot === undefined ? [] : describeSnapshot(view.snapshot));

  /** Focus returns to the control that opened the dialog while it is mounted, else to the frame. */
  function restoreFocus(trigger: HTMLElement | null): void {
    if (trigger?.isConnected === true) trigger.focus();
    if (trigger === null || document.activeElement !== trigger) restoreTarget()?.focus();
  }

  async function toggleSearch(event: MouseEvent): Promise<void> {
    if (view.searchOpen) {
      inspection.closeSearch();
      return;
    }
    searchTrigger = event.currentTarget as HTMLElement;
    inspection.openSearch();
    await tick();
    document.getElementById(searchId)?.focus();
  }

  function closeSearch(): void {
    inspection.closeSearch();
    restoreFocus(searchTrigger);
  }

  function searchKey(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      inspection.next();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeSearch();
    }
  }

  function openExport(event: MouseEvent): void {
    exportTrigger = event.currentTarget as HTMLElement;
    inspection.openSnapshot();
  }

  /** Refresh keeps focus, whether it recaptured or could not. */
  function refresh(event: MouseEvent): void {
    const control = event.currentTarget as HTMLElement;
    inspection.refreshSnapshot();
    control.focus();
  }
</script>

{#if toolbarVisible && view.available}
  <div class="cinder-terminal__inspection" role="group" aria-label="Terminal output tools">
    <Button label="Search" size="sm" aria-expanded={view.searchOpen} onclick={toggleSearch} />
    <Button label="Export" size="sm" onclick={openExport} />
    <Button label="Clear screen" size="sm" onclick={() => inspection.clear('visible')} />
    <Button label="Clear history" size="sm" onclick={() => inspection.clear('retained')} />
    <Button label="Reset terminal" size="sm" onclick={() => inspection.clear('reset')} />
  </div>
  {#if view.searchOpen}
    <div class="cinder-terminal__search">
      <Textarea
        id={searchId}
        label="Search terminal output"
        rows={1}
        value={view.query}
        oninput={(event) => inspection.setQuery(event.currentTarget.value)}
        onkeydown={searchKey}
      />
      <div class="cinder-terminal__search-actions">
        <Button
          label="Previous match"
          size="sm"
          disabled={view.search.count === 0}
          onclick={() => inspection.previous()}
        />
        <Button
          label="Next match"
          size="sm"
          disabled={view.search.count === 0}
          onclick={() => inspection.next()}
        />
        <Button label="Close search" size="sm" onclick={closeSearch} />
      </div>
      <p class="cinder-terminal__search-status" role="status" aria-atomic="true">
        {searchSummary}
      </p>
      {#if view.search.excerpt !== undefined}
        <p class="cinder-terminal__search-excerpt">
          {view.search.excerpt.before}<mark>{view.search.excerpt.match}</mark>{view.search.excerpt
            .after}
        </p>
      {/if}
    </div>
  {/if}
{/if}

<Modal
  open={view.snapshotOpen}
  title="Export terminal output"
  triggerRef={exportTrigger}
  onDismiss={() => inspection.closeSnapshot()}
  onExitComplete={() => {
    inspection.releaseSnapshot();
    restoreFocus(exportTrigger);
  }}
>
  {#if view.snapshot !== undefined}
    {@const shown = view.snapshot}
    <div role="status" aria-atomic="true">
      {#each notices as notice (notice)}
        <p>{notice}</p>
      {/each}
    </div>
    <Textarea
      id={snapshotId}
      label="Terminal output snapshot"
      value={shown.snapshot.text}
      readonly
      rows={12}
      variant="code"
    />
    {#if view.linksEnabled && shown.snapshot.links.length > 0}
      <p>Links in this output</p>
      <ul class="cinder-terminal__links">
        {#each shown.snapshot.links as link (link)}
          <li>
            <Button
              variant="secondary"
              size="sm"
              label={link}
              disabled={!shown.linksActive}
              onclick={() => inspection.activateLink(link)}
            />
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
  {#snippet footer()}
    <Button
      variant="secondary"
      disabled={view.snapshot === undefined || !view.snapshot.refreshable}
      onclick={refresh}>Refresh</Button
    >
    <CopyButton value={view.snapshot?.snapshot.text ?? ''}>Copy</CopyButton>
    <Button variant="secondary" onclick={() => inspection.downloadExport()}>Download</Button>
    <Button variant="primary" onclick={() => inspection.closeSnapshot()}>Close</Button>
  {/snippet}
</Modal>
