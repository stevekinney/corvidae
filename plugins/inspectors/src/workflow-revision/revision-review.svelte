<script lang="ts">
  /**
   * The workflow revision review (COR-2218): the current and the proposed definition side by side,
   * drawn with Cinder through the panel kit, and the one decision the reader can make. Values go in
   * as text, never as markup. The status line is one polite live region whose Cinder callout takes
   * the color of the state, and the comparison is a keyboard-scrollable region.
   */
  import { Button, Callout, Text } from '@lostgradient/cinder';

  import { applyLabel, canApply, checkHashOffer, statusText, statusVariant } from './model.ts';
  import type { RevisionView } from './view.svelte.ts';

  let {
    view,
    onApply,
    onCheckHash,
  }: { view: RevisionView; onApply: () => void; onCheckHash: () => void } = $props();

  const offer = $derived(checkHashOffer(view.state));
</script>

{#if view.phase === 'loading'}
  <p role="status" aria-live="polite" class="panel-status">Loading workflow revision…</p>
{:else if view.phase === 'failed'}
  <p role="status" aria-live="polite" class="panel-status">
    The current workflow could not be read.
  </p>
{:else}
  <main class="panel-page">
    <Text as="h1" variant="h3">Review workflow revision</Text>
    <Callout variant={statusVariant(view.state)}>
      <p role="status" aria-live="polite" data-state={view.state}>
        {statusText(view.state, view.changeCount, view.message)}
      </p>
    </Callout>
    <!-- A scrolling region is reachable by keyboard so its overflow can be read. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div
      class="revision-comparison"
      role="region"
      aria-label="Workflow definition comparison"
      tabindex="0"
    >
      <Text as="h2" variant="h4">Current and proposed</Text>
      <div class="revision-columns">
        <span></span>
        <span>Change</span>
        <span>Current</span>
        <span>Proposed</span>
      </div>
      {#each view.rows as row (row.label)}
        <div class="revision-row" data-state={row.state}>
          <strong>{row.label}</strong>
          <span class="revision-row__marker">{row.marker}</span>
          <div class="revision-value revision-value--current">
            <span class="revision-value__label">Current definition</span>
            <pre>{row.current}</pre>
          </div>
          <div class="revision-value revision-value--proposed">
            <span class="revision-value__label">Proposed definition</span>
            <pre>{row.proposed}</pre>
          </div>
        </div>
      {/each}
    </div>
    <footer class="revision-footer">
      {#if offer.offered}
        <Button
          variant="secondary"
          label="Check current hash"
          disabled={offer.disabled}
          onclick={onCheckHash}
        />
      {/if}
      <Button
        variant="primary"
        label={applyLabel(view.state)}
        disabled={!canApply(view.state)}
        onclick={onApply}
      />
    </footer>
  </main>
{/if}
