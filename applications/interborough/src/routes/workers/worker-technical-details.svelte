<script lang="ts">
  /**
   * Worker detail (plan §9.4 T5.2), the open worker of the Workers list: its status, when it last
   * spoke, the queue it serves, the tasks it is running, and its version; Drain or Resume; the
   * deployment it belongs to with the ramp and Promote or Roll back; the diagnostics the server
   * reports for it; and the server-reported session, manifest and contract verification
   * (`weft.workers.diagnostics`, COR-124).
   */
  import {
    Alert,
    Badge,
    Button,
    DescriptionList,
    PageHeader,
    SectionHeading,
    Tooltip,
  } from '@lostgradient/cinder';
  import type { Snippet } from 'svelte';

  import { formatDuration } from '../../lib/format/index.ts';
  import type { ScopeGate } from '../../lib/scopes.svelte.ts';
  import type { RegistrySnapshotSource } from '../system/registry-view.ts';
  import type { WorkerSummary } from './worker-catalog-types.ts';
  import WorkerContractVerificationPanel from './worker-contract-verification-panel.svelte';
  import WorkerManifestPanel from './worker-manifest-panel.svelte';
  import type { WorkerManifestDiagnostics } from './worker-manifest-diagnostics.ts';
  import {
    LONG_POLL_LIMITATION,
    TRANSPORT_LABEL,
    workerHealthPresentation,
  } from './worker-presentation.ts';
  import WorkerSessionPanel from './worker-session-panel.svelte';

  interface WorkerDetailViewProps {
    readonly worker: WorkerSummary;
    readonly adminGate: ScopeGate;
    readonly onDrain: () => void;
    readonly onResume: () => void;
    /** Drains every worker of the worker's deployment. */
    readonly onDrainDeployment?: (deploymentName: string) => void;
    /** Resumes the worker's deployment. */
    readonly onResumeDeployment?: (deploymentName: string) => void;
    /** The worker's deployment: its ramp, its builds, Promote and Roll back. Rendered under the deployment's name. */
    readonly deployment?: Snippet<[deploymentName: string]>;
    /** The diagnostics the server reports for this worker. */
    readonly diagnostics?: Snippet;
    readonly manifestDiagnostics?: WorkerManifestDiagnostics | null | undefined;
    readonly manifestLoading?: boolean;
    readonly manifestRefreshing?: boolean;
    readonly manifestError?: unknown;
    /** Reference instant for relative times; defaults to render time. */
    readonly now?: number;
    /** Active registry snapshot for contract verification (COR-162). */
    readonly registry?: RegistrySnapshotSource | undefined;
    readonly registryLoading?: boolean;
    readonly registryRefreshing?: boolean;
    readonly registryError?: unknown;
  }

  let {
    worker,
    adminGate,
    onDrain,
    onResume,
    onDrainDeployment = undefined,
    onResumeDeployment = undefined,
    deployment = undefined,
    diagnostics = undefined,
    manifestDiagnostics = undefined,
    manifestLoading = false,
    manifestRefreshing = false,
    manifestError = null,
    now = Date.now(),
    registry = undefined,
    registryLoading = false,
    registryRefreshing = false,
    registryError = null,
  }: WorkerDetailViewProps = $props();

  const presentation = $derived(workerHealthPresentation(worker));
  const draining = $derived(worker.health === 'draining');
  // A draining worker is finishing its tasks, a drained one has finished them: Resume undoes either.
  const drainMarked = $derived(worker.health !== 'active');

  const connectionItems = $derived([
    { term: 'Queue', definition: worker.queue },
    { term: 'Last heard from', definition: `${formatDuration(worker.heartbeatAgeMs)} ago` },
    { term: 'Running tasks', definition: `${worker.inFlight} of ${worker.concurrency}` },
    {
      term: 'Version',
      definition: [worker.buildId, worker.runtimeVersion].filter(Boolean).join(' · ') || '—',
    },
    { term: 'Transport', definition: TRANSPORT_LABEL[worker.transport] },
    { term: 'Connected', definition: formatDuration(Date.now() - worker.connectedAt) + ' ago' },
  ]);
</script>

<div class="weft-worker-detail" data-testid="worker-detail">
  <PageHeader headingLevel={2}>
    {#snippet title()}<span class="weft-workers-id" title={worker.id}>{worker.id}</span>{/snippet}
    {#snippet actions()}
      <Badge variant={presentation.variant} data-testid="worker-health">{presentation.label}</Badge>
      {#if adminGate.disabled}
        <Tooltip text={adminGate.title ?? ''}>
          <Button variant="secondary" size="sm" disabled label={drainMarked ? 'Resume' : 'Drain'} />
        </Tooltip>
      {:else if drainMarked}
        <Button data-changes variant="secondary" size="sm" label="Resume" onclick={onResume} />
      {:else}
        <Button data-changes variant="secondary" size="sm" label="Drain" onclick={onDrain} />
      {/if}
    {/snippet}
  </PageHeader>

  {#if draining}
    <Alert variant="warning">
      Draining: finishing {worker.inFlight} in-flight task{worker.inFlight === 1 ? '' : 's'},
      accepting no new work.
    </Alert>
  {/if}

  {#if worker.transport === 'long-poll'}
    <Alert variant="info">{LONG_POLL_LIMITATION}</Alert>
  {/if}

  <div class="weft-worker-detail__grid">
    <section class="weft-workers-panel" aria-labelledby="worker-connection-heading">
      <h3 id="worker-connection-heading" class="weft-workers-panel__title">Connection</h3>
      <DescriptionList items={connectionItems} />
    </section>
    <section class="weft-workers-panel" aria-labelledby="worker-activities-heading">
      <h3 id="worker-activities-heading" class="weft-workers-panel__title">Activities</h3>
      <div class="weft-worker-detail__activities">
        {#each worker.activities as activity (activity)}
          <Badge variant="neutral" monospace>{activity}</Badge>
        {/each}
      </div>
    </section>
  </div>

  {#if worker.deploymentName !== undefined && deployment}
    {@const deploymentName = worker.deploymentName}
    <section class="weft-worker-detail__section" aria-label="Deployment">
      <SectionHeading level={3} title={`Deployment ${deploymentName}`}>
        {#snippet actions()}
          {#if adminGate.disabled}
            <Tooltip text={adminGate.title ?? ''}>
              <Button variant="ghost" size="sm" disabled label="Drain deployment" />
            </Tooltip>
          {:else if onDrainDeployment && onResumeDeployment}
            <Button
              data-changes
              variant="ghost"
              size="sm"
              label="Drain deployment"
              onclick={() => onDrainDeployment(deploymentName)}
            />
            <Button
              data-changes
              variant="ghost"
              size="sm"
              label="Resume deployment"
              onclick={() => onResumeDeployment(deploymentName)}
            />
          {/if}
        {/snippet}
      </SectionHeading>
      {@render deployment(deploymentName)}
    </section>
  {/if}

  {#if diagnostics}
    <section class="weft-worker-detail__section" aria-label="Worker diagnostics">
      <SectionHeading level={3} title="Diagnostics" />
      {@render diagnostics()}
    </section>
  {/if}

  <WorkerSessionPanel
    diagnostics={manifestDiagnostics}
    loading={manifestLoading}
    error={manifestError}
    {now}
  />

  <WorkerManifestPanel
    diagnostics={manifestDiagnostics}
    loading={manifestLoading}
    refreshing={manifestRefreshing}
    error={manifestError}
    capabilities={worker.capabilities}
  />

  <WorkerContractVerificationPanel
    diagnostics={manifestDiagnostics}
    {registry}
    loading={manifestLoading || registryLoading}
    refreshing={manifestRefreshing || registryRefreshing}
    error={manifestError ?? registryError ?? null}
  />
</div>
