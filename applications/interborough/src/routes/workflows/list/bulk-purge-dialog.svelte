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
   * run named. A commit fault classified `invalid` means the token no longer
   * matches (the matched set changed since the preview), so the response is a
   * fresh preview, never a generic error; any other fault retries with the
   * same token. Both mirror `bulk-action-dialog.svelte`.
   */
  import { Badge, Button, Input, Modal, Progress, Skeleton } from '@lostgradient/cinder';
  import type { BulkOperationDryRunResult } from '@lostgradient/weft';

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

  type Phase = 'loading' | 'preview' | 'committing' | 'result' | 'fault';

  let phase = $state<Phase>('loading');
  let preview = $state<BulkOperationDryRunResult | null>(null);
  let confirmText = $state('');
  let result = $state<BulkCommitSummary | null>(null);
  let faultMessage = $state('');
  /** Which phase produced the current `fault`: a failed dry run has no token to retry with, so it re-runs the dry run. */
  let faultOrigin = $state<'loading' | 'committing'>('loading');
  /** `true` when the commit fault means "re-run the preview", not "retry the same token". */
  let faultMeansStalePreview = $state(false);

  $effect(() => {
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
      faultMeansStalePreview = treatment.kind === 'invalid';
      phase = 'fault';
    }
  }

  function retryFromFault(): void {
    if (faultOrigin === 'loading' || faultMeansStalePreview) void loadPreview();
    else void commit();
  }

  function handleDismiss(): void {
    if (phase === 'committing') return;
    onClose();
  }
</script>

<Modal
  open={true}
  title="Purge terminal workflows"
  dismissOnBackdropClick={phase !== 'committing'}
  dismissOnEscape={phase !== 'committing'}
  closeButtonVisible={phase !== 'committing'}
  onDismiss={handleDismiss}
>
  {#snippet children()}
    {#if phase === 'loading'}
      <div aria-busy="true" aria-label="Checking how many workflows a purge would remove">
        <Skeleton height="1.25rem" width="60%" />
        <Skeleton height="3rem" />
      </div>
    {:else if phase === 'preview' && preview}
      <p class="weft-bulk-dialog__lead">
        Permanently deletes <strong>{matched} terminal workflow{matched === 1 ? '' : 's'}</strong>
        matching the current filter — not just the visible page.
      </p>
      {#if chip.length > 0}
        <code class="weft-bulk-dialog__chip">{chip}</code>
      {/if}
      {#if sample.length > 0}
        <p class="weft-bulk-dialog__note">The server named these workflows to purge:</p>
        <ul class="weft-bulk-dialog__sample" aria-label="Workflows the purge would remove">
          {#each sample as workflowId (workflowId)}
            <li><code>{workflowId}</code></li>
          {/each}
        </ul>
        {#if notShown > 0}
          <p class="weft-bulk-dialog__note">…and {notShown} more.</p>
        {/if}
      {/if}
      <p class="weft-bulk-dialog__warning" role="alert">
        Purge cannot be undone. Workflows that have not finished, and finished ones that still owe a
        finalizer run, are not purged.
      </p>
      {#if matched === 0}
        <p class="weft-bulk-dialog__note">No workflows match the current filter — nothing to do.</p>
      {:else}
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
        <p class="weft-bulk-dialog__note">
          Please keep this open until it finishes. Closing this doesn't cancel the server operation
          — it will keep running.
        </p>
      </div>
    {:else if phase === 'result' && result}
      <p class="weft-bulk-dialog__headline">
        <Badge variant="success">Done</Badge>
        {result.headline}
      </p>
    {:else if phase === 'fault'}
      <p class="weft-bulk-dialog__fault" role="alert">{faultMessage}</p>
      {#if faultMeansStalePreview}
        <p class="weft-bulk-dialog__note">
          The set of matching workflows changed since the preview. Run the preview again.
        </p>
      {/if}
    {/if}
  {/snippet}

  {#snippet footer()}
    {#if phase === 'preview' && preview}
      <Button variant="ghost" size="sm" onclick={onClose}>Cancel</Button>
      {#if matched > 0}
        <Button variant="danger" size="sm" disabled={!confirmMatches} onclick={commit}>
          Purge {matched} workflow{matched === 1 ? '' : 's'}
        </Button>
      {/if}
    {:else if phase === 'result'}
      <Button variant="primary" size="sm" onclick={onClose}>Close</Button>
    {:else if phase === 'fault'}
      <Button variant="ghost" size="sm" onclick={onClose}>Close</Button>
      <Button variant="secondary" size="sm" onclick={retryFromFault}>
        {faultMeansStalePreview ? 'Refresh preview' : 'Retry'}
      </Button>
    {/if}
  {/snippet}
</Modal>

<style>
  .weft-bulk-dialog__lead {
    margin: 0 0 10px;
    font-size: var(--cinder-text-sm);
  }

  .weft-bulk-dialog__chip {
    display: block;
    margin-bottom: 12px;
    padding: var(--cinder-space-2) var(--cinder-space-2);
    background: var(--cinder-surface-inset);
    border-radius: var(--cinder-radius-sm);
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-2xs);
    color: var(--cinder-text-muted);
  }

  .weft-bulk-dialog__sample {
    margin: 6px 0 0;
    padding-inline-start: var(--cinder-space-4);
    font-size: var(--cinder-text-xs);
    color: var(--cinder-text-muted);
    max-height: 160px;
    overflow-y: auto;
  }

  .weft-bulk-dialog__warning {
    margin: 12px 0;
    font-size: var(--cinder-text-xs);
    color: var(--cinder-status-danger-text);
  }

  .weft-bulk-dialog__note {
    margin: 8px 0 0;
    font-size: var(--cinder-text-xs);
    color: var(--cinder-text-subtle);
  }

  .weft-bulk-dialog__headline {
    margin: 0;
    font-size: var(--cinder-text-sm);
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .weft-bulk-dialog__fault {
    margin: 0;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-status-danger-text);
  }

  .weft-bulk-dialog__progress {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
</style>
