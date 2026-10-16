<script lang="ts">
  /**
   * Registry detail → contract verification (COR-162): every connected
   * worker that advertises this workflow, compared with the registry's
   * active revision of it by `verifyRegistryWorkflow`, plus the copyable
   * CLI commands.
   */
  import { Badge, EmptyState, Skeleton } from '@lostgradient/cinder';

  import { truncateId } from '../../lib/format/index.ts';
  import { verifyRegistryWorkflow } from '../workers/contract-verification.ts';
  import VerificationCommandsPanel from '../workers/verification-commands-panel.svelte';
  import { trackRegistryActivityHashes } from '../workers/registry-activity-hashes.svelte.ts';
  import VerificationFaultView from '../workers/verification-fault-view.svelte';
  import WorkflowVerificationDetail from '../workers/workflow-verification-detail.svelte';
  import type { WorkerManifestDiagnostics } from '../workers/worker-manifest-diagnostics.ts';
  import type { RegistrySnapshotSource } from './registry-view.ts';

  interface RegistryContractVerificationPanelProps {
    readonly workflow: string;
    readonly registry: RegistrySnapshotSource;
    readonly diagnostics: readonly WorkerManifestDiagnostics[] | undefined;
    readonly loading: boolean;
    readonly refreshing: boolean;
    readonly error: unknown;
  }

  let {
    workflow,
    registry,
    diagnostics,
    loading: queriesLoading,
    refreshing,
    error: queryError,
  }: RegistryContractVerificationPanelProps = $props();

  const activityHashes = trackRegistryActivityHashes(() => registry);
  const error = $derived(queryError ?? activityHashes.error);
  const verification = $derived(
    diagnostics && activityHashes.hashes
      ? verifyRegistryWorkflow(workflow, diagnostics, registry, activityHashes.hashes)
      : undefined,
  );
  // A verdict computed from cached manifests outlives a failed background
  // refetch: it stays on screen, marked stale, and the fault replaces it
  // only when there is nothing to compare. The expected activity hashes are
  // derived from the snapshot asynchronously.
  const loading = $derived(
    verification === undefined &&
      !error &&
      (queriesLoading || (diagnostics !== undefined && !activityHashes.hashes)),
  );
  const driftCount = $derived(
    verification?.workers.filter((entry) => entry.verification.status !== 'matched').length ?? 0,
  );
  const singleWorker = $derived(
    verification?.workers.length === 1 ? verification.workers[0] : undefined,
  );
</script>

<section
  class="weft-contract-verification"
  aria-labelledby="registry-contract-verification-heading"
>
  <div class="weft-contract-verification__heading-row">
    <h2 id="registry-contract-verification-heading">Worker contract verification</h2>
    {#if verification && verification.workers.length > 0}
      {#if driftCount > 0}
        <Badge variant="danger"
          >Drift · {driftCount} of {verification.workers.length} worker{verification.workers
            .length === 1
            ? ''
            : 's'}</Badge
        >
      {:else}
        <Badge variant="success">Verified · every serving worker matches</Badge>
      {/if}
    {/if}
    {#if verification && error}
      <Badge variant="warning">Stale · last refresh failed</Badge>
    {:else if refreshing}
      <Badge variant="neutral">Refreshing · showing cached evidence</Badge>
    {/if}
  </div>

  {#if loading}
    <div role="status" aria-busy="true" aria-label="Loading worker contract verification">
      <Skeleton height="6rem" />
    </div>
  {:else if error && verification === undefined}
    <VerificationFaultView {error} />
  {:else if !verification || verification.workers.length === 0}
    <EmptyState
      title="No worker manifests for this workflow"
      description={`No connected worker with an accepted manifest advertises ${workflow}.`}
    />
  {:else}
    {#if error}
      <VerificationFaultView {error} />
    {/if}
    {#each verification.workers as entry (entry.workerId)}
      <div class="weft-workers-panel">
        <div class="weft-contract-verification__worker">
          <span class="weft-workers-mono" title={entry.workerId}>{truncateId(entry.workerId)}</span>
          <span class="weft-contract-verification__note"
            >{entry.deploymentName} · {entry.buildId}</span
          >
        </div>
        <WorkflowVerificationDetail
          verification={entry.verification}
          captionPrefix={`${entry.workerId} `}
        />
      </div>
    {/each}
    {#if verification.workersNotAdvertising > 0}
      <p class="weft-contract-verification__note">
        {verification.workersNotAdvertising} other connected worker{verification.workersNotAdvertising ===
        1
          ? ' does'
          : 's do'} not serve this workflow.
      </p>
    {/if}
  {/if}

  <VerificationCommandsPanel
    headingId="registry-verification-commands-heading"
    context={{
      registryVersion: registry.registryVersion,
      ...(singleWorker
        ? { deploymentName: singleWorker.deploymentName, buildId: singleWorker.buildId }
        : {}),
    }}
  />
</section>

<style>
  .weft-contract-verification {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
    margin-top: 24px;
  }

  .weft-contract-verification__heading-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  .weft-contract-verification__heading-row h2 {
    margin: 0;
    font-size: var(--cinder-text-md);
  }

  .weft-contract-verification__worker {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 8px;
  }

  .weft-contract-verification__note {
    margin: 0;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-muted);
  }
</style>
