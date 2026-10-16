<script lang="ts">
  /**
   * Worker detail → contract verification (COR-162): the worker's accepted
   * manifest compared with the active registry snapshot, computed in the
   * browser by `verifyWorkerContracts`, plus the copyable CLI commands.
   */
  import { Badge, EmptyState, Skeleton } from '@lostgradient/cinder';

  import type { RegistrySnapshotSource } from '../system/registry-view.ts';
  import { verifyWorkerContracts } from './contract-verification.ts';
  import { trackRegistryActivityHashes } from './registry-activity-hashes.svelte.ts';
  import VerificationCommandsPanel from './verification-commands-panel.svelte';
  import VerificationFaultView from './verification-fault-view.svelte';
  import WorkflowVerificationDetail from './workflow-verification-detail.svelte';
  import type { WorkerManifestDiagnostics } from './worker-manifest-diagnostics.ts';

  interface WorkerContractVerificationPanelProps {
    readonly diagnostics: WorkerManifestDiagnostics | null | undefined;
    readonly registry: RegistrySnapshotSource | undefined;
    readonly loading: boolean;
    readonly refreshing: boolean;
    readonly error: unknown;
  }

  let {
    diagnostics,
    registry,
    loading: queriesLoading,
    refreshing,
    error: queryError,
  }: WorkerContractVerificationPanelProps = $props();

  const activityHashes = trackRegistryActivityHashes(() => registry);
  const error = $derived(queryError ?? activityHashes.error);
  const verification = $derived(
    diagnostics && registry && activityHashes.hashes
      ? verifyWorkerContracts(diagnostics, registry, activityHashes.hashes)
      : undefined,
  );
  // A verdict computed from cached data outlives a failed background refetch:
  // it stays on screen, marked stale, and the fault replaces it only when
  // there is nothing to compare. The expected activity hashes are derived
  // from the snapshot asynchronously.
  const loading = $derived(
    verification === undefined &&
      !error &&
      (queriesLoading || (Boolean(diagnostics) && registry !== undefined)),
  );
</script>

<section class="weft-contract-verification" aria-labelledby="worker-contract-verification-heading">
  <div class="weft-contract-verification__heading-row">
    <h2 id="worker-contract-verification-heading">Contract verification</h2>
    {#if verification}
      {#if verification.hasDrift}
        <Badge variant="danger">Drift · manifest differs from registry</Badge>
      {:else}
        <Badge variant="success">Verified · manifest matches registry</Badge>
      {/if}
    {/if}
    {#if verification && error}
      <Badge variant="warning">Stale · last refresh failed</Badge>
    {:else if refreshing}
      <Badge variant="neutral">Refreshing · showing cached evidence</Badge>
    {/if}
  </div>

  {#if loading}
    <div role="status" aria-busy="true" aria-label="Loading contract verification">
      <Skeleton height="6rem" />
    </div>
  {:else if error && verification === undefined}
    <VerificationFaultView {error} />
  {:else if diagnostics === null}
    <EmptyState
      title="No accepted manifest"
      description="The server has no accepted manifest for this worker, so there is nothing to verify."
    />
  {:else if registry === undefined || registry.workflows.length === 0}
    <EmptyState
      title="No registry snapshot yet"
      description="The registry has no workflow revisions to compare this worker's manifest with."
    />
  {:else if verification}
    {#if error}
      <VerificationFaultView {error} />
    {/if}
    {#if verification.workflows.length === 0}
      <p class="weft-contract-verification__note">This worker advertises no workflows.</p>
    {:else}
      {#each verification.workflows as workflow (workflow.workflow)}
        <div class="weft-workers-panel">
          <WorkflowVerificationDetail verification={workflow} />
        </div>
      {/each}
    {/if}

    {#if verification.notAdvertised.length > 0}
      <details class="weft-contract-verification__not-advertised">
        <summary
          >{verification.notAdvertised.length} registry workflow{verification.notAdvertised
            .length === 1
            ? ''
            : 's'} not served by this worker</summary
        >
        <p class="weft-contract-verification__note">
          <code>weft worker verify</code> reports these as missing workflows. A worker that serves only
          part of the registry is expected to.
        </p>
        <ul>
          {#each verification.notAdvertised as name (name)}
            <li class="weft-workers-mono">{name}</li>
          {/each}
        </ul>
      </details>
    {/if}
  {/if}

  <VerificationCommandsPanel
    headingId="worker-verification-commands-heading"
    context={{
      ...(diagnostics
        ? {
            deploymentName: diagnostics.deploymentVersion.deploymentName,
            buildId: diagnostics.deploymentVersion.buildId,
          }
        : {}),
      ...(registry ? { registryVersion: registry.registryVersion } : {}),
    }}
  />
</section>

<style>
  .weft-contract-verification {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
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

  .weft-contract-verification__note {
    margin: 0;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-muted);
  }

  .weft-contract-verification__not-advertised {
    font-size: var(--cinder-text-sm);
  }
</style>
