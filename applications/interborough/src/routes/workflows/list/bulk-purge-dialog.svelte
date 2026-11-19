<script lang="ts">
  /**
   * Purge confirmation dialog (plan §9.2/§13 T8.1;
   * `weft/src/server/operations/purge-workflows.ts`).
   *
   * ## Why this is a separate dialog from `bulk-action-dialog.svelte`
   *
   * Purge follows the same dry-run / confirmation-token protocol as the five
   * filter-scoped bulk operations (COR-2521), but it stays its own dialog for
   * two reasons that still hold:
   *
   * - Its preview is what a purge would REMOVE, which differs from what the
   *   operations act on: only terminal workflows, and none that still owe a
   *   finalizer. The dialog says so, and shows a sample of the ids the server
   *   named, because a purge cannot be undone and the operator should see
   *   which workflows are about to go, not only how many.
   * - `purge()` skips `assertScopedBulkWorkflowFilter`: an EMPTY filter
   *   purges every terminal workflow the engine holds, engine-wide. The bar
   *   still requires a real scoping dimension before this dialog can open
   *   (`bulk-filter-scope.ts`) as a client-side safety rail beyond what the
   *   wire contract requires.
   *
   * `access` requires `workflows:admin`, the same scope as every other bulk
   * operation; `bulk-selection-bar.svelte` gates the Purge button behind it.
   *
   * ## Phases
   *
   * `loading` (dry run in flight) → `preview` (the server's matched count and
   * a sample of the matched ids, filter chip, type-to-confirm) → `committing`
   * (non-dismissible) → `result` | `fault`. The commit carries the dry run's
   * confirmation token, and the server deletes exactly the workflows that dry
   * run named. A commit fault with the `Conflict` code means the token no longer
   * matches (the matched set changed since the preview), so the response is a
   * warning callout with one "Refresh preview" action, never the server's
   * message. Any other commit fault shows its message, which says how many
   * workflows were deleted when the server knows, and offers "Refresh preview" too:
   * a purge never retries with the same token, because some workflows may already
   * be gone. A failed dry run deleted nothing, so it offers "Retry".
   * `bulk-action-dialog.svelte` still reads the whole `invalid` bucket, because the
   * other bulk operations still answer a stale token as `InvalidParams`.
   */
  import {
    Badge,
    Button,
    Callout,
    InlineLoading,
    Input,
    Modal,
    Progress,
  } from '@lostgradient/cinder';
  import { HttpClientError, type BulkOperationDryRunResult } from '@lostgradient/weft';
  import { onMount } from 'svelte';

  import { BULK_PURGE_COPY } from '../../../app/copy/bulk-purge.ts';
  import { faultTreatment } from '../../../lib/faults.ts';
  import { confirmPhrase, confirmPhraseMatches, filterSummaryChip } from './bulk-preview-format.ts';
  import type { BulkCommitSummary } from './bulk-result-summary.ts';

  interface BulkPurgeDialogProps {
    readonly runDryRun: () => Promise<BulkOperationDryRunResult>;
    /** `matched` is the dry-run preview's own count, passed through for the result summary. */
    readonly runPurge: (confirmationToken: string, matched: number) => Promise<BulkCommitSummary>;
    readonly onClose: () => void;
    /** Fired once purge actually succeeds — see `bulk-action-dialog.svelte`'s identical prop doc for why this is distinct from `onClose`. */
    readonly onSuccess?: () => void;
  }

  let { runDryRun, runPurge, onClose, onSuccess }: BulkPurgeDialogProps = $props();

  /** Names the sample list by the sentence that introduces it. */
  const sampleIntroId = $props.id();

  type Phase = 'loading' | 'preview' | 'committing' | 'result' | 'fault';

  let phase = $state<Phase>('loading');
  let preview = $state<BulkOperationDryRunResult | null>(null);
  let confirmText = $state('');
  let result = $state<BulkCommitSummary | null>(null);
  let faultMessage = $state('');
  /** Which phase produced the current `fault`: a failed dry run deleted nothing ("Retry"), a failed commit may have deleted some. */
  let faultOrigin = $state<'loading' | 'committing'>('loading');
  /** `true` when the server refused the commit because the matching workflows changed after the preview. */
  let faultMeansStalePreview = $state(false);

  // Once, when the dialog opens, never from an effect: an effect would track `runDryRun`, and the
  // selection bar builds it as a closure over its filter, so every list refresh that handed the bar
  // a new filter object would run the preview again and clear the phrase being typed. A change of
  // filter does not change what this open dialog was asked to purge; "Refresh preview" is the one
  // way to count again.
  onMount(() => {
    void loadPreview();
  });

  async function loadPreview(): Promise<void> {
    phase = 'loading';
    confirmText = '';
    try {
      preview = await runDryRun();
      phase = 'preview';
    } catch (error) {
      faultMessage = faultTreatment(error).message;
      faultOrigin = 'loading';
      faultMeansStalePreview = false;
      phase = 'fault';
    }
  }

  const matched = $derived(preview?.matched ?? 0);
  const phrase = $derived(confirmPhrase('purge', matched));
  const confirmMatches = $derived(confirmPhraseMatches(confirmText, phrase));
  const chip = $derived(preview ? filterSummaryChip(preview.scope.filter) : '');
  const sample = $derived(preview?.sampleWorkflowIds ?? []);
  const notShown = $derived(Math.max(0, matched - sample.length));

  async function commit(): Promise<void> {
    if (!preview || !confirmMatches) return;
    const token = preview.confirmationToken;
    const previewMatched = preview.matched;
    phase = 'committing';
    try {
      result = await runPurge(token, previewMatched);
      phase = 'result';
      onSuccess?.();
    } catch (error) {
      const treatment = faultTreatment(error);
      faultMessage = treatment.message;
      faultOrigin = 'committing';
      // Only the server's `Conflict` means the matching workflows moved after the preview. Other
      // `invalid` faults (a malformed filter, a missing token) are input the preview cannot fix.
      faultMeansStalePreview = error instanceof HttpClientError && error.faultCode === 'Conflict';
      phase = 'fault';
    }
  }

  /**
   * The one way out of a fault. A purge cannot be undone, so a failed commit never retries with the
   * same token: some workflows may already be gone, and the token names the set as it was. The
   * preview counts what is left, and a new phrase confirms it.
   */
  function refreshPreview(): void {
    void loadPreview();
  }

  function handleDismiss(): void {
    if (phase === 'committing') return;
    onClose();
  }
</script>

<Modal
  open={true}
  title={BULK_PURGE_COPY.title}
  dismissOnBackdropClick={phase !== 'committing'}
  dismissOnEscape={phase !== 'committing'}
  closeButtonVisible={phase !== 'committing'}
  onDismiss={handleDismiss}
>
  {#snippet children()}
    {#if phase === 'loading'}
      <!-- Its own status region announces the count in flight; the dialog is not busy-labelled. -->
      <InlineLoading status="active" description={BULK_PURGE_COPY.loading} />
    {:else if phase === 'preview' && preview}
      {#if matched === 0}
        <p class="weft-bulk-dialog__lead">{BULK_PURGE_COPY.preview.nothing}</p>
      {:else}
        <p class="weft-bulk-dialog__lead">{BULK_PURGE_COPY.preview.lead(matched)}</p>
      {/if}
      {#if chip.length > 0}
        <code class="weft-bulk-dialog__chip">{chip}</code>
      {/if}
      {#if matched > 0}
        {#if sample.length > 0}
          <p class="weft-bulk-dialog__note" id={sampleIntroId}>
            {BULK_PURGE_COPY.preview.sampleIntro}
          </p>
          <ul class="weft-bulk-dialog__sample" aria-labelledby={sampleIntroId}>
            {#each sample as workflowId (workflowId)}
              <li><code>{workflowId}</code></li>
            {/each}
          </ul>
          {#if notShown > 0}
            <p class="weft-bulk-dialog__note">{BULK_PURGE_COPY.preview.notShown(notShown)}</p>
          {/if}
        {/if}
        <p class="weft-bulk-dialog__note">{BULK_PURGE_COPY.preview.kept}</p>
        <Input
          id="bulk-purge-confirm-text"
          label={`Type "${phrase}" to confirm`}
          bind:value={confirmText}
          autocomplete="off"
        />
      {/if}
    {:else if phase === 'committing'}
      <div class="weft-bulk-dialog__progress">
        <Progress ariaLabel="Purge in progress" />
        <p class="weft-bulk-dialog__note">{BULK_PURGE_COPY.committing}</p>
      </div>
    {:else if phase === 'result' && result}
      <p class="weft-bulk-dialog__headline">
        <Badge variant="success">Done</Badge>
        {result.headline}
      </p>
    {:else if phase === 'fault'}
      {#if faultMeansStalePreview}
        <!-- The result of the person's action, so it is announced; the callout is static. -->
        <div role="alert">
          <Callout variant="warning" semantic="note" title={BULK_PURGE_COPY.stale.title}>
            {#snippet action()}
              <Button variant="secondary" size="sm" onclick={refreshPreview}>
                {BULK_PURGE_COPY.stale.refreshAction}
              </Button>
            {/snippet}
            {BULK_PURGE_COPY.stale.body}
          </Callout>
        </div>
      {:else}
        <p class="weft-bulk-dialog__fault" role="alert">{faultMessage}</p>
        {#if faultOrigin === 'committing'}
          <!-- The commit may have deleted some workflows before it failed, or been cut off; the preview says what is left. -->
          <p class="weft-bulk-dialog__note">{BULK_PURGE_COPY.failed.refreshNote}</p>
        {/if}
      {/if}
    {/if}
  {/snippet}

  {#snippet footer()}
    {#if phase === 'loading' || (phase === 'preview' && preview)}
      <!--
        The footer stays while the preview loads or refreshes, with a live Cancel and a Purge that
        cannot be pressed yet, so focus always has a stable target and the dialog does not change
        height as the preview arrives.
      -->
      <!-- With nothing to purge there is nothing to cancel: the one action closes the dialog. -->
      <Button variant="ghost" size="sm" onclick={onClose}>
        {phase === 'preview' && matched === 0 ? BULK_PURGE_COPY.preview.closeAction : 'Cancel'}
      </Button>
      {#if phase === 'loading'}
        <Button variant="danger" size="sm" disabled>Purge</Button>
      {:else if matched > 0}
        <Button variant="danger" size="sm" disabled={!confirmMatches} onclick={commit}>
          Purge {matched} workflow{matched === 1 ? '' : 's'}
        </Button>
      {/if}
    {:else if phase === 'result'}
      <Button variant="primary" size="sm" onclick={onClose}>Close</Button>
    {:else if phase === 'fault'}
      <Button variant="ghost" size="sm" onclick={onClose}>Close</Button>
      <!-- A stale preview carries its own Refresh action in the callout. -->
      {#if !faultMeansStalePreview}
        <Button variant="secondary" size="sm" onclick={refreshPreview}>
          {faultOrigin === 'committing'
            ? BULK_PURGE_COPY.stale.refreshAction
            : BULK_PURGE_COPY.failed.retryAction}
        </Button>
      {/if}
    {/if}
  {/snippet}
</Modal>

<style>
  /* The sentence that says what happens and that it cannot be undone, at the dialog's body size. */
  .weft-bulk-dialog__lead {
    margin: 0 0 var(--cinder-space-3);
    font-size: var(--cinder-text-body);
    font-weight: 600;
  }

  .weft-bulk-dialog__chip {
    display: block;
    margin-bottom: var(--cinder-space-3);
    padding: var(--cinder-space-2) var(--cinder-space-2);
    background: var(--cinder-surface-inset);
    border-radius: var(--cinder-radius-sm);
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-2xs);
    color: var(--cinder-text-muted);
    /* A filter summary can hold one long unbroken value (an id prefix, a type name); it wraps. */
    overflow-wrap: anywhere;
  }

  .weft-bulk-dialog__sample {
    margin: var(--cinder-space-2) 0 0;
    padding-inline-start: var(--cinder-space-4);
    font-size: var(--cinder-text-xs);
    color: var(--cinder-text-muted);
    max-height: 10rem;
    overflow-y: auto;
  }

  /* A workflow id is one long unbroken token; it wraps at any character rather than widening the dialog. */
  .weft-bulk-dialog__sample li,
  .weft-bulk-dialog__sample code {
    overflow-wrap: anywhere;
  }

  .weft-bulk-dialog__note {
    margin: var(--cinder-space-2) 0 0;
    font-size: var(--cinder-text-xs);
    color: var(--cinder-text-subtle);
  }

  .weft-bulk-dialog__headline {
    margin: 0;
    font-size: var(--cinder-text-sm);
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: var(--cinder-space-2);
  }

  .weft-bulk-dialog__fault {
    margin: 0;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-status-danger-text);
  }

  .weft-bulk-dialog__progress {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
  }
</style>
