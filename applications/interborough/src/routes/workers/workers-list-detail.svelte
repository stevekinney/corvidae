<script lang="ts">
  /**
   * The Workers tab: every worker the server lists, with the open worker beside it (design rows 20c
   * and 19a). The counts are one line under the title, not four cards. The open worker is the
   * `worker` parameter of the address, so a link to one worker opens it. A `worker` the server does
   * not list says so in the detail pane, with the way back to the list. That pane is only on screen
   * in the side-by-side layout: below the list's push width one pane shows at a time, and an
   * unlisted worker has no row to open, so the list shows and the message does not.
   *
   * Everything the page reads is handed in by the route (`index.svelte`), which owns the queries and
   * the writes; this component decides only how they are laid out.
   */
  import { untrack } from 'svelte';

  import {
    Badge,
    Button,
    EmptyState,
    ListDetail,
    Meter,
    SelectableRow,
  } from '@lostgradient/cinder';

  import { formatDuration, truncateId } from '../../lib/format/index.ts';
  import { routerSelectionLocationFor } from '../../lib/router-selection-location.ts';
  import { router } from '../../lib/router.svelte.ts';
  import type { ScopeGate } from '../../lib/scopes.svelte.ts';
  import type { RegistrySnapshotSource } from '../system/registry-view.ts';
  import type { WorkerSummary } from './worker-catalog-types.ts';
  import ManifestDiagnosticsView from './manifest-diagnostics-view.svelte';
  import type {
    WorkerManifestDiagnostics,
    WorkerRegistrationRejection,
  } from './worker-manifest-diagnostics.ts';
  import { TRANSPORT_LABEL, workerHealthPresentation } from './worker-presentation.ts';
  import DeploymentsPanel from './deployments-panel.svelte';
  import WorkerDetailView from './worker-detail-view.svelte';
  import WorkerDiagnosticsSection from './worker-diagnostics-section.svelte';

  interface WorkersListDetailProps {
    readonly workers: readonly WorkerSummary[];
    /** The line under the title: how many are connected, running, waiting, and failed for good. */
    readonly summary: string;
    readonly adminGate: ScopeGate;
    readonly onDrain: (worker: WorkerSummary) => void;
    readonly onResume: (workerId: string) => void;
    readonly onDrainDeployment: (deploymentName: string) => void;
    readonly onResumeDeployment: (deploymentName: string) => void;
    readonly onInspectTask: (operationId: string) => void;
    /** What the fleet's manifests say; undefined until they have been read. */
    readonly manifestDiagnostics: readonly WorkerManifestDiagnostics[] | undefined;
    readonly registrationRejections: readonly WorkerRegistrationRejection[];
    /** The fleet-level view's state: the manifest read and the registration-rejection read together. */
    readonly manifestLoading: boolean;
    readonly manifestRefreshing: boolean;
    readonly manifestError: unknown;
    /**
     * The open worker's state: the manifest read alone, so a failed or pending rejection read does
     * not hide a worker whose manifest loaded.
     */
    readonly workerManifestLoading: boolean;
    readonly workerManifestRefreshing: boolean;
    readonly workerManifestError: unknown;
    readonly registry: RegistrySnapshotSource | undefined;
    readonly registryLoading: boolean;
    readonly registryRefreshing: boolean;
    readonly registryError: unknown;
  }

  let {
    workers,
    summary,
    adminGate,
    onDrain,
    onResume,
    onDrainDeployment,
    onResumeDeployment,
    onInspectTask,
    manifestDiagnostics,
    registrationRejections,
    manifestLoading,
    manifestRefreshing,
    manifestError,
    workerManifestLoading,
    workerManifestRefreshing,
    workerManifestError,
    registry,
    registryLoading,
    registryRefreshing,
    registryError,
  }: WorkersListDetailProps = $props();

  const selectionLocation = routerSelectionLocationFor('/health/workers');

  // The list reads the address once, when it opens; a link to another worker while this page is
  // open (the command palette, a diagnostic's worker link) is followed here.
  let selectedKey = $state<string | null>(null);
  const requested = $derived(router.search.get('worker'));
  $effect(() => {
    const next = requested;
    // Only the address drives this: a row chosen here reaches the address through the list, and
    // following the selection back would undo the choice before the address had moved.
    untrack(() => {
      if (next !== selectedKey) selectedKey = next;
    });
  });

  function manifestOf(worker: WorkerSummary): WorkerManifestDiagnostics | null | undefined {
    // Undefined until the fleet's manifests have been read; null when they were, and none is this worker's.
    return (
      manifestDiagnostics?.find((entry) => entry.instance.workerId === worker.id) ??
      (manifestDiagnostics === undefined ? undefined : null)
    );
  }

  function backToList(): void {
    selectedKey = null;
  }
</script>

<div class="weft-workers-frame" data-shortcut-region="list-detail">
  <ListDetail
    items={[...workers]}
    key={(worker) => worker.id}
    label="Workers"
    detailLabel="Worker"
    emptyTitle="Choose a worker"
    emptyDescription="Choose a worker from the list to see its queue, tasks, deployment and diagnostics."
    selectionParameter="worker"
    {selectionLocation}
    bind:selectedKey
    storageKey="interborough-workers"
  >
    {#snippet header()}
      <p class="weft-workers-frame__summary" data-testid="workers-summary">{summary}</p>
    {/snippet}
    {#snippet list(worker, row)}
      {@const presentation = workerHealthPresentation(worker)}
      <SelectableRow
        selected={row.selected}
        selectedState="current"
        onclick={row.open}
        data-worker-row={worker.id}
      >
        {#snippet title()}<span class="weft-workers-id" title={worker.id}
            >{truncateId(worker.id)}</span
          >{/snippet}
        {#snippet description()}
          <span class="weft-workers-mono">{worker.queue}</span>
          {#if worker.deploymentName}· {worker.deploymentName}{/if}
          · {TRANSPORT_LABEL[worker.transport]}
          · {formatDuration(worker.heartbeatAgeMs)} ago
        {/snippet}
        {#snippet meta()}
          <Badge variant={presentation.variant} size="sm">{presentation.label}</Badge>
          <Meter
            value={worker.inFlight}
            max={worker.concurrency}
            size="sm"
            ariaLabel={`In-flight tasks for worker ${worker.id}`}
            ariaValueText={`${worker.inFlight} of ${worker.concurrency}`}
          />
        {/snippet}
      </SelectableRow>
    {/snippet}
    {#snippet listEmpty()}
      <EmptyState
        kind="first-use"
        size="compact"
        headingLevel={3}
        title="No workers connected"
        description="Connect a remote worker to this queue to see it here. The documentation explains how."
      />
    {/snippet}
    {#snippet empty()}
      {#if selectedKey !== null}
        <EmptyState
          kind="first-use"
          headingLevel={2}
          title="Worker closed"
          description={`No worker with the ID ${selectedKey} is registered with the server. It has closed, or it never connected here.`}
        >
          {#snippet action()}
            <Button
              variant="secondary"
              size="sm"
              label="Back to all workers"
              onclick={backToList}
            />
          {/snippet}
        </EmptyState>
      {:else}
        <EmptyState
          kind="first-use"
          headingLevel={2}
          title="Choose a worker"
          description="Choose a worker from the list to see its queue, tasks, deployment and diagnostics."
        />
      {/if}
    {/snippet}
    {#snippet detail(worker)}
      <WorkerDetailView
        {worker}
        {adminGate}
        onDrain={() => onDrain(worker)}
        onResume={() => onResume(worker.id)}
        {onDrainDeployment}
        {onResumeDeployment}
        manifestDiagnostics={manifestOf(worker)}
        manifestLoading={workerManifestLoading}
        manifestRefreshing={workerManifestRefreshing}
        manifestError={workerManifestError}
        {registry}
        {registryLoading}
        {registryRefreshing}
        {registryError}
      >
        {#snippet deployment(deploymentName)}
          <DeploymentsPanel workers={[...workers]} {deploymentName} />
        {/snippet}
        {#snippet diagnostics()}
          <WorkerDiagnosticsSection workerId={worker.id} {onInspectTask} />
        {/snippet}
      </WorkerDetailView>
    {/snippet}
  </ListDetail>
</div>

<ManifestDiagnosticsView
  diagnostics={manifestDiagnostics ?? []}
  rejections={registrationRejections}
  refreshing={manifestRefreshing}
  loading={manifestLoading}
  error={manifestError}
/>
