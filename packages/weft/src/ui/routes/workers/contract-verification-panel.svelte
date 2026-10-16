<script lang="ts">
  /**
   * Contract verification (COR-162): which workflows and activities each worker's accepted
   * manifest is missing, has extra, or has drifted on, relative to the active registry snapshot.
   * Rendered on Worker detail (one manifest, every workflow) and on Registry definition detail
   * (every manifest that serves the definition, that workflow only). The comparison runs in the
   * browser (`contract-verification.ts`); the copyable CLI commands sit beside it.
   */
  import { Badge, EmptyState, Skeleton, Table } from '@lostgradient/cinder';

  import { FAULT_TREATMENT_TITLE, faultTreatment } from '../../lib/faults.ts';
  import { truncateId } from '../../lib/format/index.ts';
  import { isForbidden } from '../../lib/scopes.svelte.ts';
  import { isRegistryEmpty, type RegistrySnapshotSource } from '../system/registry-view.ts';
  import ContractVerificationCommands from './contract-verification-commands.svelte';
  import {
    CONTRACT_DRIFT_DESCRIPTIONS,
    CONTRACT_DRIFT_LABELS,
    contractDriftSubject,
    verifyWorkerManifests,
    type ContractVerificationReport,
  } from './contract-verification.ts';
  import {
    MalformedWorkerDiagnosticsError,
    type WorkerManifestDiagnostics,
  } from './worker-manifest-diagnostics.ts';

  interface ContractVerificationPanelProps {
    readonly diagnostics: readonly WorkerManifestDiagnostics[];
    readonly snapshot: RegistrySnapshotSource | undefined;
    readonly loading: boolean;
    readonly refreshing: boolean;
    readonly error: unknown;
    /** Limits the comparison to one workflow and to the workers that serve it. */
    readonly workflowName?: string | undefined;
  }

  let {
    diagnostics,
    snapshot,
    loading,
    refreshing,
    error,
    workflowName = undefined,
  }: ContractVerificationPanelProps = $props();

  const uid = $props.id();

  const reports = $derived<Promise<readonly ContractVerificationReport[]>>(
    snapshot === undefined || diagnostics.length === 0
      ? Promise.resolve([])
      : verifyWorkerManifests(diagnostics, snapshot, workflowName),
  );

  const commandIdentity = $derived(
    diagnostics.length === 1 ? diagnostics[0]?.deploymentVersion : undefined,
  );
</script>

{#snippet reportView(report: ContractVerificationReport)}
  <li class="weft-contract-verification__report">
    <div class="weft-contract-verification__report-header">
      <span class="weft-workers-mono" title={report.workerId}>{truncateId(report.workerId)}</span>
      <span class="weft-contract-verification__build"
        >{report.deploymentName} · {report.buildId}</span
      >
      {#if report.drift.length === 0}
        <Badge variant="success">Matches registry</Badge>
      {:else}
        <Badge variant="danger"
          >Drift · {report.drift.length} finding{report.drift.length === 1 ? '' : 's'}</Badge
        >
      {/if}
    </div>
    {#if report.drift.length === 0}
      <p class="weft-contract-verification__note">
        Every compared workflow and activity matches the active revision ({report.workflows.length} workflow{report
          .workflows.length === 1
          ? ''
          : 's'}).
      </p>
    {:else}
      <Table caption={`Contract drift for worker ${report.workerId}`} scrollable>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>Workflow / activity</Table.HeaderCell>
            <Table.HeaderCell>Finding</Table.HeaderCell>
            <Table.HeaderCell>Registry</Table.HeaderCell>
            <Table.HeaderCell>Manifest</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each report.drift as entry (`${entry.kind}:${contractDriftSubject(entry)}`)}
            <Table.Row>
              <Table.Cell as="th" class="weft-workers-mono"
                >{contractDriftSubject(entry)}</Table.Cell
              >
              <Table.Cell>
                <span class="weft-contract-verification__finding">
                  <strong>{CONTRACT_DRIFT_LABELS[entry.kind]}</strong>
                  <span>{CONTRACT_DRIFT_DESCRIPTIONS[entry.kind]}</span>
                  {#if entry.reason}
                    <span class="weft-workers-mono">{entry.reason}</span>
                  {/if}
                </span>
              </Table.Cell>
              <Table.Cell class="weft-workers-mono" title={entry.expected}
                >{entry.expected === undefined ? '—' : truncateId(entry.expected)}</Table.Cell
              >
              <Table.Cell class="weft-workers-mono" title={entry.actual}
                >{entry.actual === undefined ? '—' : truncateId(entry.actual)}</Table.Cell
              >
            </Table.Row>
          {/each}
        </Table.Body>
      </Table>
    {/if}
  </li>
{/snippet}

<section class="weft-contract-verification" aria-labelledby={`${uid}-heading`}>
  <div class="weft-contract-verification__heading-row">
    <h2 id={`${uid}-heading`}>Contract verification</h2>
    {#if refreshing}<Badge variant="neutral">Refreshing · showing cached evidence</Badge>{/if}
  </div>
  <p class="weft-contract-verification__note">
    Compares each accepted worker manifest with the active registry snapshot, the same check
    <code>weft worker verify</code> runs.
  </p>

  {#if loading}
    <div role="status" aria-busy="true" aria-label="Loading contract verification">
      <Skeleton height="6rem" />
    </div>
  {:else if error}
    {#if isForbidden(error)}
      <EmptyState
        title="Permission denied"
        description="Comparing worker manifests with the registry requires the system:read scope."
      />
    {:else if error instanceof MalformedWorkerDiagnosticsError}
      <EmptyState title="Malformed server response" description={error.message} />
    {:else}
      {@const treatment = faultTreatment(error)}
      <EmptyState title={FAULT_TREATMENT_TITLE[treatment.kind]} description={treatment.message} />
    {/if}
  {:else if snapshot === undefined || isRegistryEmpty(snapshot)}
    <EmptyState
      title="No registry snapshot yet"
      description="The registry has no eagerly registered definitions to compare manifests against."
    />
  {:else if diagnostics.length === 0}
    <EmptyState
      title="No accepted manifests"
      description="No connected worker has a server-accepted manifest to verify."
    />
  {:else}
    {#await reports}
      <div role="status" aria-busy="true" aria-label="Comparing manifests with the registry">
        <Skeleton height="4rem" />
      </div>
    {:then resolved}
      {#if resolved.length === 0}
        <EmptyState
          title="No worker serves this workflow"
          description="No connected worker's accepted manifest advertises this definition."
        />
      {:else}
        <ul class="weft-contract-verification__reports">
          {#each resolved as report (report.workerId)}
            {@render reportView(report)}
          {/each}
        </ul>
      {/if}
    {:catch failure}
      <EmptyState
        title="Verification could not run"
        description={failure instanceof Error ? failure.message : String(failure)}
      />
    {/await}
  {/if}

  <ContractVerificationCommands identity={commandIdentity} />
</section>

<style>
  .weft-contract-verification {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
  }
  .weft-contract-verification__heading-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
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
  .weft-contract-verification__reports {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .weft-contract-verification__report {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .weft-contract-verification__report-header {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .weft-contract-verification__build {
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-muted);
    overflow-wrap: anywhere;
  }
  .weft-contract-verification__finding {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
</style>
