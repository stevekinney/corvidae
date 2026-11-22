<script lang="ts">
  /**
   * The dry-run-then-commit confirmation for every filter-scoped bulk workflow operation: the five
   * actions (cancel, signal, retry-failed, delete, mutate tags — plan §9.2/§10.6 T8.1; design
   * `Weft Patterns.dc.html` Tier-3 mock) and purge, which `bulk-purge-dialog.svelte` configures
   * with its own words, its sample of ids and its own retry rule. One flow, one pattern: Cinder's
   * `ConfirmDialog` with a typed confirmation, so the sheet layout on a phone, the focus on Cancel
   * and the failure callout are inherited, never rebuilt here.
   *
   * ## Phases
   *
   * `params` (only when a `parameters` snippet is supplied — signal needs a name/payload, tags
   * needs an add/remove + tag list; cancel/retry/delete skip straight to `loading`) → `loading`
   * (dry run in flight: the dialog is `pending`) → `preview` (matched count, filter chip, typed
   * confirmation) → `committing` (`busy`: nothing can dismiss it) → `result` | `fault`.
   *
   * The footer is `ConfirmDialog`'s, in every phase, so the dialog keeps its height from the first
   * pass to the last. Cancel becomes "Close" once there is nothing left to cancel (no matches, a
   * result, a fault).
   *
   * ## Faults
   *
   * Every fault is one callout with its re-run action in the same slot (`errorAction`), never a
   * footer button. A commit fault with the `Conflict` code means the confirmation token no longer
   * matches the current dry-run scope — weft's `BulkOperationConfirmationError`
   * (`weft/src/core/engine/errors.ts`), which every bulk operation answers as `Conflict`
   * (`staleConfirmationFault`), content-based, not time-based: it fires when the matched set
   * changed between preview and commit. The response is a warning callout with "Refresh preview",
   * never a generic error. Any OTHER commit fault (a malformed request, network, `EngineFailure`)
   * offers a same-token "Retry" (`commitRetry="same-token"`), since the token itself is still
   * valid; a purge sets `commitRetry="new-preview"` instead, because some workflows may already be
   * gone and the token names the set as it was. A fault from `loading` means the dry run itself
   * never returned a preview, so its "Retry" re-runs the dry run whatever the fault was.
   */
  import { Badge, ConfirmDialog, Progress } from '@lostgradient/cinder';
  import { onMount, tick, type Snippet } from 'svelte';
  import { HttpClientError, type BulkOperationDryRunResult } from '@lostgradient/weft';

  import { BULK_DIALOG_COPY } from '../../../app/copy/bulk-dialog.ts';
  import { faultTreatment } from '../../../lib/faults.ts';
  import { confirmPhrase, filterSummaryChip } from './bulk-preview-format.ts';
  import type { BulkCommitSummary } from './bulk-result-summary.ts';

  interface BulkActionDialogProps {
    readonly title: string;
    /** Lowercase verb used in both the type-to-confirm phrase and the confirm button label — "cancel", "retry", "delete", "add tags to", "remove tags from", "purge". */
    readonly verb: string;
    readonly destructive?: boolean;
    /** Optional pre-preview parameter form (signal name/payload, tags op/list). Cancel/retry-failed/delete omit this and go straight to the dry run. */
    readonly parameters?: Snippet;
    /** Gates leaving the `params` phase — ignored when `parameters` is omitted. */
    readonly parametersValid?: boolean;
    readonly runDryRun: () => Promise<BulkOperationDryRunResult>;
    /** `matched` is the dry-run preview's own count, passed through so the caller can build a "N of M" result summary without re-deriving state this dialog already holds. */
    readonly runCommit: (confirmationToken: string, matched: number) => Promise<BulkCommitSummary>;
    readonly onClose: () => void;
    /** Optional free-text note rendered in the `preview` phase, below the matched-count/filter-chip line — e.g. the retry-failed dialog's revision-retention explanation (WFT-117). Omitted for callers with nothing to add. Ignored when `details` is supplied. */
    readonly previewNote?: string;
    /**
     * Fired once, right when a commit actually succeeds — independent of
     * when (or whether) the user clicks the result phase's "Close" button
     * afterward. Distinct from `onClose` deliberately: `onClose` also fires
     * for every dismissal that did NOT commit anything (Escape, backdrop,
     * the params/preview phase's "Cancel"), where invalidating queries is
     * harmless but clearing the caller's row selection would not be — the
     * caller might want to retry a DIFFERENT action against the same
     * selection. Optional so a caller with nothing to do on success isn't forced
     * to declare an unused prop.
     */
    readonly onSuccess?: () => void;
    /** The sentence that says what happens, as the dialog's description. Defaults to "Operates on all N matching workflows — not just the visible page." */
    readonly lead?: Snippet<[BulkOperationDryRunResult]>;
    /** What goes under the filter chip, as the dialog's options: a list, notes. Defaults to the finalizer-skip note, `previewNote` and the nothing-to-do note. */
    readonly details?: Snippet<[BulkOperationDryRunResult]>;
    /** Said while the dry run is in flight. */
    readonly loadingLabel?: string;
    /** The confirm button's label while there is no count to name yet. Defaults to "<Verb> workflows". */
    readonly loadingConfirmLabel?: string;
    /** Said, in place of the lead, when the count is zero. Defaults to the sentence for "workflows". */
    readonly nothingMatches?: string;
    /**
     * What the operation does, without a count, for a dialog whose dry run failed and so has none.
     * Defaults to the sentence for the five actions.
     */
    readonly purpose?: string;
    /** The filter summary of the workflows the dialog acts on, known before the dry run, for the same dialog. */
    readonly filterChip?: string;
    /**
     * Our own title for a commit fault that is not stale, in place of "Couldn’t <verb> the
     * workflows", such as a purge's "may be part done, so refresh". The server's message is never
     * the title: it is the body.
     */
    readonly commitFailedTitle?: string;
    /**
     * What a commit fault that is not stale offers. `same-token` sends the same commit again, which
     * is safe when the fault left the matched set alone. `new-preview` counts again, for an
     * operation that cannot be repeated as it was.
     */
    readonly commitRetry?: 'same-token' | 'new-preview';
  }

  let {
    title,
    verb,
    destructive = true,
    parameters,
    parametersValid = true,
    runDryRun,
    runCommit,
    onClose,
    onSuccess,
    previewNote,
    lead,
    details,
    loadingLabel = 'Checking how many workflows match',
    loadingConfirmLabel,
    nothingMatches = BULK_DIALOG_COPY.nothingMatches('workflows', 'do'),
    purpose = BULK_DIALOG_COPY.purpose,
    filterChip = '',
    commitFailedTitle,
    commitRetry = 'same-token',
  }: BulkActionDialogProps = $props();

  type Phase = 'params' | 'loading' | 'preview' | 'committing' | 'result' | 'fault';

  /**
   * The dialog lives exactly as long as its parent mounts it: `onClose` is how it asks to go, and
   * the parent unmounts it. Nothing else closes it, so a dismissal never hides a dialog whose
   * parent still holds it (the count may still be loading behind a Cancel the parent ignored).
   */
  const isOpen = (): boolean => true;
  function stayMounted(): void {
    // Intentionally nothing: the parent's `onClose` handler removes the dialog.
  }

  // Intentional one-shot capture: `bulk-selection-bar.svelte` renders one
  // literal `<BulkActionDialog>` per `{#if activeAction === '…'}` branch,
  // each with its own fixed `parameters` snippet (or none) baked in —
  // switching `activeAction` destroys and recreates the whole instance, so
  // `parameters` never changes under a still-mounted dialog. Tracking it
  // reactively would also be wrong here: `phase` is meant to *start* in
  // 'params' and then move forward through the flow, not snap back to
  // 'params' if a later, unrelated re-render happened to re-evaluate this.
  // svelte-ignore state_referenced_locally
  let phase = $state<Phase>(parameters ? 'params' : 'loading');
  let preview = $state<BulkOperationDryRunResult | null>(null);
  let result = $state<BulkCommitSummary | null>(null);
  let faultMessage = $state('');
  /**
   * Which phase produced the current `fault` — decides what "Retry" does.
   * A fault from `loading` means the dry run itself never returned a
   * `preview` (nothing to commit yet, and nothing for the stale-token
   * question to apply to), so retry must re-run the dry run regardless of
   * fault kind. Getting this wrong left "Retry" as a silent no-op after a
   * failed initial dry run (`commit()`'s own `!preview` guard swallowed it);
   * `bulk-selection-bar.test.ts` covers the path.
   */
  let faultOrigin = $state<'loading' | 'committing'>('loading');
  /** `true` when the commit fault means "re-run the preview", not "retry the same token". Only meaningful when `faultOrigin === 'committing'`. */
  let faultMeansStalePreview = $state(false);
  /** The preview's lead sentence, where focus goes after a reload. */
  let leadElement = $state<HTMLElement>();
  /** Set by "Refresh preview" and "Retry", so only a reload (never the first open) moves focus to the lead. */
  let focusLeadOnPreview = false;

  // Once, when the dialog opens, never from an effect: an effect would track `runDryRun`, and the
  // selection bar builds it as a closure over its filter, so every list refresh that handed the bar
  // a new filter object would run the preview again and clear the phrase being typed. A change of
  // filter does not change what this open dialog was asked to act on; "Refresh preview" is the one
  // way to count again. A dialog with a `parameters` form runs its dry run from "Continue" instead.
  onMount(() => {
    if (!parameters) void loadPreview();
  });

  async function loadPreview(): Promise<void> {
    phase = 'loading';
    try {
      preview = await runDryRun();
      phase = 'preview';
      if (focusLeadOnPreview) {
        focusLeadOnPreview = false;
        // The lead renders with the preview phase; focus it once it exists.
        await tick();
        leadElement?.focus();
      }
    } catch (error) {
      faultMessage = faultTreatment(error).message;
      faultOrigin = 'loading';
      faultMeansStalePreview = false;
      phase = 'fault';
    }
  }

  /**
   * Counts again. The button that was pressed unmounts while the count reloads, so when the new
   * preview lands focus goes to its lead sentence and the new count is read. The first open keeps
   * Cinder's initial focus.
   */
  function reloadPreview(): void {
    focusLeadOnPreview = true;
    void loadPreview();
  }

  const matched = $derived(preview?.matched ?? 0);
  const phrase = $derived(confirmPhrase(verb, matched));
  const chip = $derived(preview ? filterSummaryChip(preview.scope.filter) : '');
  const verbLabel = $derived(`${verb[0]?.toUpperCase() ?? ''}${verb.slice(1)}`);
  const countLabel = $derived(`${matched} workflow${matched === 1 ? '' : 's'}`);

  async function commit(): Promise<void> {
    if (!preview || preview.matched === 0) return;
    const token = preview.confirmationToken;
    const previewMatched = preview.matched;
    phase = 'committing';
    try {
      result = await runCommit(token, previewMatched);
      phase = 'result';
      onSuccess?.();
    } catch (error) {
      faultMessage = faultTreatment(error).message;
      faultOrigin = 'committing';
      // Only the server's `Conflict` means the matching workflows moved after the preview. Other
      // `invalid` faults (a malformed filter, a missing token) are input the preview cannot fix.
      faultMeansStalePreview = error instanceof HttpClientError && error.faultCode === 'Conflict';
      phase = 'fault';
    }
  }

  function handleConfirm(): void {
    if (phase === 'params') {
      if (parametersValid) void loadPreview();
    } else if (phase === 'preview') {
      void commit();
    }
  }

  /** The one fault callout: its words, its tone, and the action that re-runs what failed. */
  const fault = $derived.by(() => {
    if (phase !== 'fault') return undefined;
    if (faultOrigin === 'loading') {
      return {
        title: BULK_DIALOG_COPY.dryRunFailed,
        body: faultMessage,
        tone: 'danger' as const,
        action: { label: 'Retry', onAction: reloadPreview },
      };
    }
    if (faultMeansStalePreview) {
      return {
        title: BULK_DIALOG_COPY.stale.title,
        body: BULK_DIALOG_COPY.stale.body,
        tone: 'warning' as const,
        action: { label: 'Refresh preview', onAction: reloadPreview },
      };
    }
    return {
      title: commitFailedTitle ?? BULK_DIALOG_COPY.commitFailed(verb),
      body: faultMessage,
      tone: 'danger' as const,
      action:
        commitRetry === 'new-preview'
          ? { label: 'Refresh preview', onAction: reloadPreview }
          : { label: 'Retry', onAction: () => void commit() },
    };
  });

  const hasMatches = $derived(phase === 'preview' && matched > 0);
  /** A commit that failed still says what it was asked to do: the count and the filter stay. */
  const faultKeepsPreview = $derived(
    phase === 'fault' && faultOrigin === 'committing' && preview !== null,
  );
  /** A dry run that failed has no count, but the dialog still says what it is for, and for which workflows. */
  const faultKeepsPurpose = $derived(phase === 'fault' && faultOrigin === 'loading');
  const showsDescription = $derived(
    (phase === 'preview' && preview !== null) ||
      faultKeepsPreview ||
      faultKeepsPurpose ||
      phase === 'committing' ||
      (phase === 'result' && result !== null),
  );
  const showsOptions = $derived(
    (phase === 'params' && parameters !== undefined) ||
      (phase === 'preview' && preview !== null) ||
      (faultKeepsPreview && chip.length > 0) ||
      (faultKeepsPurpose && filterChip.length > 0) ||
      phase === 'committing' ||
      (phase === 'result' && result !== null && (!!result.note || result.errors.length > 0)),
  );
  /** Nothing is left to confirm once there are no matches, a result, or a fault: Cancel closes. */
  const confirmVisible = $derived(
    phase === 'params' || phase === 'loading' || phase === 'committing' || hasMatches,
  );
  const confirmLabel = $derived(
    phase === 'params'
      ? 'Continue'
      : phase === 'loading'
        ? (loadingConfirmLabel ?? `${verbLabel} workflows`)
        : `${verbLabel} ${countLabel}`,
  );
</script>

{#snippet defaultLead(dryRun: BulkOperationDryRunResult)}
  Operates on all <strong
    >{dryRun.matched} matching workflow{dryRun.matched === 1 ? '' : 's'}</strong
  >
  — not just the visible page.
{/snippet}

{#snippet defaultDetails(dryRun: BulkOperationDryRunResult)}
  {#if dryRun.skippedTeardownPending && dryRun.skippedTeardownPending.length > 0}
    <p>
      {dryRun.skippedTeardownPending.length} of these still owe a finalizer run and will be skipped.
    </p>
  {/if}
  {#if previewNote}
    <p>{previewNote}</p>
  {/if}
{/snippet}

{#snippet phaseDescription()}
  {#if faultKeepsPurpose}
    <span>{purpose}</span>
  {:else if (phase === 'preview' || faultKeepsPreview) && preview}
    <!-- Focusable by script only: after a reload, focus lands here so the new count is read. -->
    <span tabindex="-1" bind:this={leadElement}>
      {#if preview.matched === 0}
        {nothingMatches}
      {:else if lead}
        {@render lead(preview)}
      {:else}
        {@render defaultLead(preview)}
      {/if}
    </span>
  {:else if phase === 'committing'}
    {BULK_DIALOG_COPY.committing}
  {:else if phase === 'result' && result}
    <Badge variant="success">Done</Badge>
    {result.headline}
  {/if}
{/snippet}

{#snippet phaseOptions()}
  {#if phase === 'params'}
    {@render parameters?.()}
  {:else if faultKeepsPurpose}
    <p><code>{filterChip}</code></p>
  {:else if faultKeepsPreview}
    <p><code>{chip}</code></p>
  {:else if phase === 'preview' && preview}
    {#if chip.length > 0}
      <p><code>{chip}</code></p>
    {/if}
    {#if details}{@render details(preview)}{:else}{@render defaultDetails(preview)}{/if}
  {:else if phase === 'committing'}
    <Progress ariaLabel={`${title} in progress`} />
  {:else if phase === 'result' && result}
    {#if result.note}
      <p>{result.note}</p>
    {/if}
    {#if result.errors.length > 0}
      <ul>
        {#each result.errors as entry (entry.id)}
          <li><code>{entry.id}</code> — {entry.error}</li>
        {/each}
      </ul>
    {/if}
  {/if}
{/snippet}

<ConfirmDialog
  bind:open={isOpen, stayMounted}
  {title}
  {...showsDescription ? { description: phaseDescription } : {}}
  {...showsOptions ? { options: phaseOptions } : {}}
  {...hasMatches ? { typeToConfirm: phrase } : {}}
  {confirmLabel}
  destructive={destructive && phase !== 'params'}
  confirmEnabled={phase !== 'params' || parametersValid}
  {confirmVisible}
  cancelLabel={confirmVisible ? 'Cancel' : 'Close'}
  pending={phase === 'loading'}
  pendingLabel={loadingLabel}
  busy={phase === 'committing'}
  error={fault?.body}
  errorTitle={fault?.title}
  errorTone={fault?.tone ?? 'danger'}
  errorAction={fault?.action}
  closeOnConfirm={false}
  onConfirm={handleConfirm}
  onCancel={onClose}
/>
