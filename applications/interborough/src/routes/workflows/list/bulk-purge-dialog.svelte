<script lang="ts">
  /**
   * Purge confirmation dialog (plan §9.2/§13 T8.1;
   * `weft/src/server/operations/purge-workflows.ts`).
   *
   * Purge follows the same dry-run / confirmation-token protocol as the five filter-scoped bulk
   * operations (COR-2521), so it is the one dialog of `bulk-action-dialog.svelte` with its own
   * words and its own rules, supplied as props:
   *
   * - Its preview is what a purge would REMOVE, which differs from what the operations act on: only
   *   terminal workflows, and none that still owe a finalizer. The lead sentence (the dialog's
   *   `description`) says so and that it cannot be undone; the options list a sample of the ids the
   *   server named and what is kept, because a purge cannot be undone and the operator should see
   *   which workflows are about to go, not only how many.
   * - `purge()` skips `assertScopedBulkWorkflowFilter`: an EMPTY filter purges every terminal
   *   workflow the engine holds, engine-wide. The bar still requires a real scoping dimension
   *   before this dialog can open (`bulk-filter-scope.ts`) as a client-side safety rail beyond what
   *   the wire contract requires.
   * - A commit fault with the `Conflict` code means the token no longer matches (the matched set
   *   changed since the preview), so the response is a warning callout with one "Refresh preview"
   *   action, never the server's message. Any other commit fault shows its message, which says how
   *   many workflows were deleted when the server knows, and offers "Refresh preview" too
   *   (`commitRetry="new-preview"`): a purge never retries with the same token, because some
   *   workflows may already be gone. A failed dry run deleted nothing, so it offers "Retry". Every
   *   bulk operation answers a stale token as `Conflict`, and the shared dialog reads it the same
   *   way.
   *
   * `access` requires `workflows:admin`, the same scope as every other bulk operation;
   * `bulk-selection-bar.svelte` gates the Purge button behind it.
   */
  import type { BulkOperationDryRunResult } from '@lostgradient/weft';

  import { BULK_DIALOG_COPY } from '../../../app/copy/bulk-dialog.ts';
  import { BULK_PURGE_COPY, PURGE_SAMPLE_SHOWN } from '../../../app/copy/bulk-purge.ts';
  import BulkActionDialog from './bulk-action-dialog.svelte';
  import type { BulkCommitSummary } from './bulk-result-summary.ts';

  interface BulkPurgeDialogProps {
    readonly runDryRun: () => Promise<BulkOperationDryRunResult>;
    /** `matched` is the dry-run preview's own count, passed through for the result summary. */
    readonly runPurge: (confirmationToken: string, matched: number) => Promise<BulkCommitSummary>;
    readonly onClose: () => void;
    /** Fired once purge actually succeeds — see `bulk-action-dialog.svelte`'s identical prop doc for why this is distinct from `onClose`. */
    readonly onSuccess?: () => void;
    /** The filter summary of the workflows to purge, shown when the count itself failed. */
    readonly filterChip?: string;
  }

  let { runDryRun, runPurge, onClose, onSuccess, filterChip = '' }: BulkPurgeDialogProps = $props();

  /** Names the sample list by the sentence that introduces it. */
  const sampleIntroId = $props.id();
</script>

{#snippet lead(preview: BulkOperationDryRunResult)}
  {BULK_PURGE_COPY.preview.lead(preview.matched)}
{/snippet}

<!-- A few ids, not all of them: the rest are counted, so the typed field stays in view. -->
{#snippet details(preview: BulkOperationDryRunResult)}
  {#if preview.matched > 0}
    {@const sample = (preview.sampleWorkflowIds ?? []).slice(0, PURGE_SAMPLE_SHOWN)}
    {#if sample.length > 0}
      <p id={sampleIntroId}>{BULK_PURGE_COPY.preview.sampleIntro}</p>
      <ul aria-labelledby={sampleIntroId}>
        {#each sample as workflowId (workflowId)}
          <li><code>{workflowId}</code></li>
        {/each}
      </ul>
      {#if preview.matched > sample.length}
        <p>{BULK_PURGE_COPY.preview.notShown(preview.matched - sample.length)}</p>
      {/if}
    {/if}
    <p>{BULK_PURGE_COPY.preview.kept}</p>
  {/if}
{/snippet}

<BulkActionDialog
  title={BULK_PURGE_COPY.title}
  verb="purge"
  {runDryRun}
  runCommit={runPurge}
  {onClose}
  {...onSuccess ? { onSuccess } : {}}
  {lead}
  {details}
  loadingLabel={BULK_PURGE_COPY.loading}
  loadingConfirmLabel={BULK_PURGE_COPY.preview.confirmWhileCounting}
  nothingMatches={BULK_DIALOG_COPY.nothingMatches('finished workflows', 'purge')}
  purpose={BULK_PURGE_COPY.purpose}
  {filterChip}
  commitFailedTitle={BULK_PURGE_COPY.failed.title}
  commitRetry="new-preview"
/>
