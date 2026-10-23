<script lang="ts">
  /**
   * Conditional refresh panel (COR-166), mounted on the Registry workflow
   * detail below the revisions panel. For the workflow's opted-in refresh
   * source it shows, from `weft.workflows.refresh.diagnostics` alone, the
   * refresh state, the candidate artifact beside the revision active now
   * (revision, contract hash, digest), the ETag, the last check, the last
   * failure as a bounded reason, and whether checks run by manual
   * maintenance or by polling (with its policy, backoff, and next check).
   * The console runs no timer of its own: every time here comes from the
   * server and is re-read when the operator refreshes.
   *
   * Actions, each one generated operation, share one in-flight action per
   * source: "Check now" (`weft.workflows.refresh`, install without
   * activating), "Check and activate" (the same operation with
   * `activate: "if-compatible"` under the generation fence), and "Activate
   * candidate" (`weft.workflows.revisions.activate` on the installed
   * candidate, the way the revisions panel activates). Both activating
   * actions ask for confirmation. Every outcome is rendered as text by
   * `refresh-outcome.ts` or `compatibility-verdict.ts`.
   */
  import { Badge, Button, ConfirmDialog, DescriptionList, Skeleton } from '@lostgradient/cinder';
  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { getClient } from '../../lib/client.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { getPrincipalStore, scopeGate } from '../../lib/scopes.svelte.ts';
  import ActivationOutcomeBanner from './activation-outcome-banner.svelte';
  import {
    describeActivationOutcome,
    resolveExpectedGeneration,
    type WorkflowActivationOutcome,
  } from './compatibility-verdict.ts';
  import QueryFaultBanner from './query-fault-banner.svelte';
  import RefreshOutcomeBanner from './refresh-outcome-banner.svelte';
  import {
    describeRefreshOutcome,
    refreshFailureLabel,
    type RefreshOutcome,
  } from './refresh-outcome.ts';
  import {
    activeGeneration,
    hasPendingCandidate,
    modeSummary,
    parseRefreshDiagnostics,
    REFRESH_STATE_LABELS,
    sourceFields,
    type RefreshSourceView,
  } from './refresh-view.ts';

  interface Props {
    workflowName: string;
  }

  let { workflowName }: Props = $props();

  const client = getClient();
  const principal = getPrincipalStore();
  const queryClient = useQueryClient();

  const canRead = $derived(principal.hasScope('workflows:read'));
  const adminGate = $derived(scopeGate(principal, ['workflows:admin']));

  const diagnosticsQuery = createQuery(() => ({
    queryKey: queryKeys.catalog.refresh(workflowName),
    queryFn: (): Promise<unknown> =>
      client.operations['weft.workflows.refresh.diagnostics']({ name: workflowName }),
    enabled: canRead,
  }));

  /** `undefined` while there is no response, or when the response is malformed (see `malformed`). */
  const view = $derived(
    diagnosticsQuery.data === undefined
      ? undefined
      : parseRefreshDiagnostics(diagnosticsQuery.data),
  );
  const malformed = $derived(diagnosticsQuery.data !== undefined && view === undefined);
  /** A refetch failed but an earlier answer is still on screen. */
  const stale = $derived(diagnosticsQuery.isError && diagnosticsQuery.data !== undefined);
  const refreshing = $derived(diagnosticsQuery.isFetching && diagnosticsQuery.data !== undefined);
  const now = $derived(
    diagnosticsQuery.dataUpdatedAt === 0 ? Date.now() : diagnosticsQuery.dataUpdatedAt,
  );

  type Action = 'check' | 'check-and-activate' | 'activate-candidate';

  type ActionResult =
    | { readonly kind: 'check'; readonly outcome: RefreshOutcome }
    | { readonly kind: 'activation'; readonly outcome: WorkflowActivationOutcome };

  /**
   * The `currentGeneration` a stale refusal most recently reported, for the
   * same reason `workflow-revisions-panel.svelte` keeps one: a read of the
   * active generation can lag the durable truth that the refusal just gave.
   */
  let pendingExpectedGeneration = $state<number | null>(null);

  function invalidateAfterAction(): void {
    void queryClient.invalidateQueries({ queryKey: queryKeys.catalog.refresh(workflowName) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.catalog.revisions(workflowName) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.catalog.active(workflowName) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.registry() });
  }

  /** The generation fence an activating action will send, as of now. */
  function fenceFor(source: RefreshSourceView): number | undefined {
    return resolveExpectedGeneration(pendingExpectedGeneration, activeGeneration(source));
  }

  async function runCheck(
    activate: boolean,
    expectedGeneration: number | undefined,
  ): Promise<ActionResult> {
    let outcome: RefreshOutcome;
    try {
      const value = await client.operations['weft.workflows.refresh']({
        name: workflowName,
        ...(activate ? { activate: 'if-compatible', expectedGeneration } : {}),
      });
      outcome = describeRefreshOutcome({ ok: true, value }, workflowName);
    } catch (error) {
      outcome = describeRefreshOutcome({ ok: false, error }, workflowName);
    }
    pendingExpectedGeneration =
      outcome.kind === 'not-activated' &&
      (outcome.refusal.reason === 'stale-generation' ||
        outcome.refusal.reason === 'expected-generation-required')
        ? outcome.refusal.currentGeneration
        : null;
    return { kind: 'check', outcome };
  }

  async function runActivation(
    source: RefreshSourceView,
    expectedGeneration: number | undefined,
  ): Promise<ActionResult> {
    if (source.candidate === undefined) throw new Error('There is no candidate to activate.');
    let outcome: WorkflowActivationOutcome;
    try {
      const raw = await client.operations['weft.workflows.revisions.activate']({
        name: workflowName,
        revision: source.candidate.revision,
        ...(expectedGeneration === undefined ? {} : { expectedGeneration }),
      });
      outcome = describeActivationOutcome(
        isAppliedPointer(raw)
          ? { applied: true, pointer: raw.pointer }
          : { applied: false, error: new Error('Malformed activation response') },
      );
    } catch (error) {
      outcome = describeActivationOutcome({ applied: false, error });
    }
    pendingExpectedGeneration = outcome.kind === 'stale' ? outcome.currentGeneration : null;
    return { kind: 'activation', outcome };
  }

  function isAppliedPointer(value: unknown): value is {
    applied: true;
    pointer: { revision: string; generation: number; activatedAt: number };
  } {
    if (typeof value !== 'object' || value === null) return false;
    const record = value as Record<string, unknown>;
    const pointer = record['pointer'];
    if (record['applied'] !== true || typeof pointer !== 'object' || pointer === null) return false;
    const fields = pointer as Record<string, unknown>;
    return (
      typeof fields['revision'] === 'string' &&
      typeof fields['generation'] === 'number' &&
      typeof fields['activatedAt'] === 'number'
    );
  }

  const actionMutation = createMutation<ActionResult, unknown, ConfirmedAction>(() => ({
    mutationFn: ({ action, source, expectedGeneration }) =>
      action === 'activate-candidate'
        ? runActivation(source, expectedGeneration)
        : runCheck(action === 'check-and-activate', expectedGeneration),
    onSuccess: invalidateAfterAction,
  }));

  /**
   * What the open confirmation will do, captured when it opened: the source as
   * the operator saw it and the generation fence the dialog names. The dialog's
   * words and the request both read this one snapshot, so nothing that changes
   * while the dialog is open (a refetch, a stale refusal) can make them differ.
   */
  interface ConfirmedAction {
    readonly action: Action;
    readonly source: RefreshSourceView;
    readonly expectedGeneration: number | undefined;
  }

  let confirming = $state<ConfirmedAction | null>(null);
  let confirmOpen = $state(false);
  let triggerRef = $state<HTMLElement | null>(null);

  function confirmAction(action: Action, source: RefreshSourceView, trigger: HTMLElement): void {
    confirming = { action, source, expectedGeneration: fenceFor(source) };
    triggerRef = trigger;
    confirmOpen = true;
  }
</script>

<section class="weft-refresh-panel" aria-label="Conditional refresh">
  <div class="weft-refresh-panel__header">
    <h3 class="weft-refresh-panel__title">Conditional refresh</h3>
    {#if refreshing}
      <span class="weft-refresh-panel__refreshing" role="status">Refreshing…</span>
    {/if}
  </div>

  {#if !canRead}
    <p class="weft-refresh-panel__note">Requires workflows:read to view refresh sources.</p>
  {:else if diagnosticsQuery.isPending}
    <div role="status" aria-busy="true" aria-label="Loading refresh sources">
      <Skeleton height="6rem" />
    </div>
  {:else if diagnosticsQuery.isError && diagnosticsQuery.data === undefined}
    <QueryFaultBanner error={diagnosticsQuery.error} onRetry={() => diagnosticsQuery.refetch()} />
  {:else if malformed || view === undefined}
    <div class="weft-refresh-panel__malformed" role="alert">
      The server returned refresh diagnostics this console doesn't recognize — showing nothing
      rather than a guess.
    </div>
  {:else}
    {#if stale}
      <div class="weft-refresh-panel__stale">
        <p class="weft-refresh-panel__note">
          Showing the last answer. Re-reading the refresh sources failed.
        </p>
        <QueryFaultBanner
          error={diagnosticsQuery.error}
          onRetry={() => diagnosticsQuery.refetch()}
        />
      </div>
    {/if}

    {#if view.sources.length === 0}
      <p class="weft-refresh-panel__note">
        No refresh source is registered for this workflow. The host opts a workflow in by
        registering a source with engine.workflows.registerRefreshSource().
      </p>
    {:else}
      {@const mode = modeSummary(view.polling, now)}
      {#each view.sources as source (source.name)}
        <article class="weft-refresh-panel__source" aria-label={`Refresh source ${source.name}`}>
          <div class="weft-refresh-panel__source-identity">
            <span class="weft-refresh-panel__source-name">{source.name}</span>
            <Badge variant={source.state === 'failed' ? 'danger' : 'neutral'}>
              {REFRESH_STATE_LABELS[source.state]}
            </Badge>
            <Badge variant={mode.mode === 'polling' ? 'info' : 'neutral'}>
              {mode.mode === 'polling' ? 'Polling' : 'Manual maintenance'}
            </Badge>
          </div>

          {#if source.reason !== undefined}
            <p class="weft-refresh-panel__failure" role="status">
              Last check failed: {refreshFailureLabel(source.reason)}
            </p>
          {/if}

          <p class="weft-refresh-panel__note">{mode.description}</p>
          {#if mode.mode === 'polling'}
            <DescriptionList
              class="weft-refresh-panel__fields"
              variant="two-column"
              items={mode.fields.map((field) => ({ term: field.term, definition: field.value }))}
            />
          {/if}

          <DescriptionList
            class="weft-refresh-panel__fields"
            variant="two-column"
            items={sourceFields(source, now).map((field) => ({
              term: field.term,
              definition: field.value,
            }))}
          />

          <div class="weft-refresh-panel__actions">
            <Button
              size="sm"
              variant="secondary"
              label="Check now"
              disabled={adminGate.disabled || actionMutation.isPending}
              loading={actionMutation.isPending &&
                actionMutation.variables?.source.name === source.name}
              title={adminGate.title}
              onclick={() =>
                actionMutation.mutate({ action: 'check', source, expectedGeneration: undefined })}
            />
            <Button
              size="sm"
              variant="secondary"
              label="Check and activate"
              disabled={adminGate.disabled || actionMutation.isPending}
              title={adminGate.title}
              onclick={(event) =>
                confirmAction('check-and-activate', source, event.currentTarget as HTMLElement)}
            />
            {#if hasPendingCandidate(source)}
              <Button
                size="sm"
                variant="secondary"
                label="Activate candidate"
                disabled={adminGate.disabled || actionMutation.isPending}
                title={adminGate.title}
                onclick={(event) =>
                  confirmAction('activate-candidate', source, event.currentTarget as HTMLElement)}
              />
            {/if}
          </div>
        </article>
      {/each}
    {/if}
  {/if}

  {#if actionMutation.isSuccess}
    {#if actionMutation.data.kind === 'check'}
      <RefreshOutcomeBanner
        outcome={actionMutation.data.outcome}
        onRefresh={() => void diagnosticsQuery.refetch()}
      />
    {:else}
      <ActivationOutcomeBanner
        outcome={actionMutation.data.outcome}
        verb="Activated"
        onRefresh={() => void diagnosticsQuery.refetch()}
      />
    {/if}
  {/if}
</section>

<ConfirmDialog
  bind:open={confirmOpen}
  {triggerRef}
  title={confirming?.action === 'activate-candidate'
    ? 'Activate the candidate?'
    : 'Check the source and activate?'}
  description={confirming === null
    ? ''
    : confirming.action === 'activate-candidate'
      ? `Activate "${confirming.source.candidate?.revision ?? ''}" as the active revision for ${workflowName}? Weft evaluates compatibility against the active revision first; an incompatible candidate is refused with no durable change.`
      : `Check ${workflowName}'s refresh source and, when the new candidate is compatible, activate it under generation ${String(confirming.expectedGeneration)}. A stale generation or an incompatible candidate leaves it installed and inactive.`}
  confirmLabel={confirming?.action === 'activate-candidate' ? 'Activate' : 'Check and activate'}
  onConfirm={() => {
    if (confirming !== null) actionMutation.mutate(confirming);
  }}
/>

<style>
  .weft-refresh-panel {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .weft-refresh-panel__header {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .weft-refresh-panel__title {
    margin: 0;
    font-size: var(--cinder-text-sm);
    font-weight: 600;
  }

  .weft-refresh-panel__refreshing {
    font-size: var(--cinder-text-2xs);
    color: var(--cinder-text-subtle);
  }

  .weft-refresh-panel__note {
    margin: 0;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-subtle);
  }

  .weft-refresh-panel__stale {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .weft-refresh-panel__malformed {
    padding: var(--cinder-density-pad-block) var(--cinder-space-3);
    border-radius: var(--cinder-radius-md);
    background: var(--cinder-status-warning-background);
    border: 1px solid var(--cinder-status-warning-border);
    color: var(--cinder-status-warning-text);
    font-size: var(--cinder-text-sm);
  }

  .weft-refresh-panel__source {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: var(--cinder-density-pad-block) var(--cinder-density-pad-inline);
    background: var(--cinder-surface-raised);
    border: 1px solid var(--cinder-border);
    border-radius: var(--cinder-radius-lg);
  }

  /* A content hash or ETag has no break opportunity: wrap it anywhere so the whole value stays
     visible and selectable at 375 and 768 pixels instead of running past the card. */
  :global(.weft-refresh-panel__fields dt),
  :global(.weft-refresh-panel__fields dd) {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .weft-refresh-panel__source-identity {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }

  .weft-refresh-panel__source-name {
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-sm);
    font-weight: 600;
  }

  .weft-refresh-panel__failure {
    margin: 0;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-status-danger-text);
  }

  .weft-refresh-panel__actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
</style>
