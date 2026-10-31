<script lang="ts">
  import { Badge, EmptyState, Skeleton, Table } from '@lostgradient/cinder';

  import { keyedByOccurrence } from '../../lib/list-keys.ts';
  import { formatRelativeTime, truncateId } from '../../lib/format/index.ts';
  import PanelFault from './panel-fault.svelte';
  import {
    compareDeploymentManifests,
    REGISTRATION_REJECTION_LABELS,
    type WorkerManifestDiagnostics,
    type WorkerRegistrationRejection,
  } from './worker-manifest-diagnostics.ts';

  interface ManifestDiagnosticsViewProps {
    readonly diagnostics: readonly WorkerManifestDiagnostics[];
    readonly rejections: readonly WorkerRegistrationRejection[];
    readonly refreshing?: boolean;
    readonly heading?: string;
    readonly loading?: boolean;
    readonly error?: unknown;
  }

  let {
    diagnostics,
    rejections,
    refreshing = false,
    heading = 'Manifest diagnostics',
    loading = false,
    error = null,
  }: ManifestDiagnosticsViewProps = $props();

  const comparisons = $derived(compareDeploymentManifests(diagnostics));
</script>

<section class="weft-manifest-diagnostics" aria-labelledby="manifest-diagnostics-heading">
  <div class="weft-manifest-diagnostics__heading-row">
    <h2 id="manifest-diagnostics-heading">{heading}</h2>
    {#if refreshing}<Badge variant="neutral">Refreshing · showing cached evidence</Badge>{/if}
  </div>

  {#if loading}
    <div role="status" aria-busy="true" aria-label="Loading manifest diagnostics">
      <Skeleton height="4rem" />
    </div>
  {:else if error}
    <PanelFault {error} />
  {:else if diagnostics.length === 0 && rejections.length === 0}
    <EmptyState
      kind="first-use"
      size="compact"
      headingLevel={3}
      title="No manifest diagnostics"
      description="No accepted worker manifests or recent admission rejections are available."
    />
  {:else}
    <div class="weft-manifest-diagnostics__summary" aria-label="Manifest acceptance summary">
      <span><strong>{diagnostics.length}</strong> accepted and routing-eligible</span>
      <span><strong>{rejections.length}</strong> recent admission rejections</span>
    </div>

    <h3>Same-build comparison</h3>
    {#if comparisons.length === 0}
      <EmptyState
        kind="done"
        size="compact"
        headingLevel={4}
        title="Nothing to compare"
        description="No two connected workers claim the same deployment and build identifier."
      />
    {:else}
      <ul class="weft-manifest-comparison-list">
        {#each comparisons as comparison (`${comparison.deploymentName}:${comparison.buildId}`)}
          <li class="weft-manifest-comparison-row">
            <div>
              <span class="weft-manifest-comparison-row__title"
                >{comparison.deploymentName} · {comparison.buildId}</span
              >
              <span class="weft-manifest-comparison-row__workers"
                >{comparison.workers.length} workers</span
              >
            </div>
            {#if comparison.disagreements.length === 0}
              <Badge variant="success">Consistent · routing eligible</Badge>
            {:else}
              <Badge variant="danger">Disagreement · {comparison.disagreements.join(', ')}</Badge>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}

    <h3>Recent admission rejections</h3>
    {#if rejections.length === 0}
      <EmptyState
        kind="done"
        size="compact"
        headingLevel={4}
        title="No rejections"
        description="No recent registration attempt was rejected."
      />
    {:else}
      <Table caption="Recent worker admission rejections" scrollable>
        <Table.Header>
          <Table.Row>
            <Table.HeaderCell>Reason</Table.HeaderCell>
            <Table.HeaderCell>Worker</Table.HeaderCell>
            <Table.HeaderCell>Queue</Table.HeaderCell>
            <Table.HeaderCell>Deployment / build</Table.HeaderCell>
            <Table.HeaderCell>Rejected</Table.HeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {#each keyedByOccurrence(rejections, (rejection) => `${rejection.rejectedAt}:${rejection.workerId ?? ''}`) as { key, item: rejection } (key)}
            <Table.Row>
              <Table.Cell>
                <Badge variant="danger">{REGISTRATION_REJECTION_LABELS[rejection.code]}</Badge>
              </Table.Cell>
              <Table.Cell class="weft-workers-mono">{rejection.workerId ?? 'Unknown'}</Table.Cell>
              <Table.Cell class="weft-workers-mono">{rejection.queue ?? 'Unknown'}</Table.Cell>
              <Table.Cell class="weft-workers-mono"
                >{rejection.deploymentName ?? 'Unknown'} · {rejection.buildId ??
                  'Unknown'}</Table.Cell
              >
              <Table.Cell title={new Date(rejection.rejectedAt).toISOString()}
                >{formatRelativeTime(rejection.rejectedAt)}</Table.Cell
              >
            </Table.Row>
          {/each}
        </Table.Body>
      </Table>
    {/if}

    <details class="weft-manifest-diagnostics__accepted">
      <summary>Accepted manifest digests ({diagnostics.length})</summary>
      <ul>
        {#each diagnostics as entry (entry.instance.workerId)}
          <li>
            <span title={entry.instance.workerId}>{truncateId(entry.instance.workerId)}</span>
            <code>{entry.deploymentVersion.manifestDigest}</code>
          </li>
        {/each}
      </ul>
    </details>
  {/if}
</section>
