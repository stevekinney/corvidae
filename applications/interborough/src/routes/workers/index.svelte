<script lang="ts">
  /**
   * Workers route root (plan §9.4, §13 T5.1–T5.4): Fleet overview / Workers /
   * Task queues / Diagnostics tabs, URL-owned (`?tab=`, `?worker=`,
   * `?queue=`) per plan §4 "URL owns filter/pagination/tab state". Owns the
   * three list queries, every mutation, and the drain/clear-dead-letter
   * dialogs; view components stay presentational.
   *
   * ## Live connect/disconnect (plan §9.4 T5.1)
   *
   * `EmptyState`+`Lock` gates the whole surface on `system:read`; an opt-in
   * "Live" toggle (default OFF per plan §5 UI treatment) subscribes to the
   * shell's ONE shared `FleetEventSource` (`getFleetEventSource()`,
   * `src/app/engine-status.svelte.ts`), filtering client-side to
   * `worker:connected`/`worker:disconnected` and invalidating the three
   * queries on either. The toggle only gates this subscription — it never
   * constructs or closes a connection of its own — mirroring
   * `schedule-detail.svelte`'s and the Workflows list track's identical
   * pattern (`workflow-list-live.svelte.ts`), per plan §5's "one fleet SSE
   * … never per-row/per-surface connections" budget. The always-on 30s poll
   * (`workers-data.ts`'s `REFETCH_INTERVAL_MS`) is the "polling fallback"
   * half of the requirement and runs regardless of the Live toggle.
   *
   * ## Reconnect-grace-period nuance (plan §9.4)
   *
   * Deliberately NOT modeled as a distinct UI state — see
   * `worker-presentation.ts`'s module doc for why no wire signal exists to
   * derive one from, and why "never flap to disconnected" is satisfied
   * structurally instead (every view here renders directly from the current
   * `weft.workers.list` snapshot; nothing here ever synthesizes a
   * client-side "disconnected" row).
   */
  import { Button, EmptyState, Skeleton, Tab, TabList, TabPanel, Tabs } from '@lostgradient/cinder';
  import Lock from '@lucide/svelte/icons/lock';

  import { createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { getClient } from '../../lib/client.ts';
  import { FAULT_TREATMENT_TITLE, faultTreatment } from '../../lib/faults.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import {
    getPrincipalStore,
    isForbidden,
    scopeGate,
    scopeReason,
  } from '../../lib/scopes.svelte.ts';
  import type { DrainTarget } from './drain-dialog.svelte';
  import DrainDialog from './drain-dialog.svelte';
  import ClearDeadLetterDialog from './clear-dead-letter-dialog.svelte';
  import ConformancePanel from './conformance-panel.svelte';
  import DeploymentsPanel from './deployments-panel.svelte';
  import DiagnosticsFilterBar from './diagnostics-filter-bar.svelte';
  import FleetView from './fleet-view.svelte';
  import TaskDeadLetterPanel from './task-dead-letter-panel.svelte';
  import TaskDeliveryHistory from './task-delivery-history.svelte';
  import QueueListView from './queue-list-view.svelte';
  import WorkerDetailView from './worker-detail-view.svelte';
  import WorkerListView from './worker-list-view.svelte';
  import { countByTransport } from './worker-presentation.ts';
  import WorkersLiveStatus from './workers-live-status.svelte';
  import {
    hasProvenanceFilters,
    readProvenanceFilters,
    writeProvenanceFilters,
  } from './provenance-filters.ts';
  import {
    TASK_HEARTBEAT_STALE_AFTER_MS,
    type TaskProvenanceFilters,
  } from './worker-catalog-types.ts';
  import {
    clearDeadLetterMutation,
    drainDeploymentMutation,
    drainWorkerMutation,
    resumeDeploymentMutation,
    resumeWorkerMutation,
    taskDiagnosticsQuery,
    taskLedgerDetailQuery,
    taskQueuesListQuery,
    workersListQuery,
    loadFleetManifestDiagnostics,
    loadRegistrySnapshot,
    loadWorkerRegistrationRejections,
    invalidateWorkerSurfaceQueries,
  } from './workers-data.ts';

  type TaskLedgerDetailModule = typeof import('./task-ledger-panel.svelte');
  type DiagnosticsViewModule = typeof import('./diagnostics-view.svelte');
  type QueueDetailViewModule = typeof import('./queue-detail-view.svelte');
  let taskLedgerDetailModule: Promise<TaskLedgerDetailModule> | undefined;
  let diagnosticsViewModule: Promise<DiagnosticsViewModule> | undefined;
  let queueDetailViewModule: Promise<QueueDetailViewModule> | undefined;

  function loadTaskLedgerDetailView(): Promise<TaskLedgerDetailModule> {
    taskLedgerDetailModule ??= import('./task-ledger-panel.svelte');
    return taskLedgerDetailModule;
  }

  function loadDiagnosticsView(): Promise<DiagnosticsViewModule> {
    diagnosticsViewModule ??= import('./diagnostics-view.svelte');
    return diagnosticsViewModule;
  }

  function loadQueueDetailView(): Promise<QueueDetailViewModule> {
    queueDetailViewModule ??= import('./queue-detail-view.svelte');
    return queueDetailViewModule;
  }

  const client = getClient();
  const principalStore = getPrincipalStore();
  const queryClient = useQueryClient();

  const locked = $derived(!principalStore.hasScope('system:read'));
  const adminGate = $derived(scopeGate(principalStore, ['system:admin']));

  const workersQuery = workersListQuery(client);
  const queuesQuery = taskQueuesListQuery(client);
  const diagnosticsQuery = taskDiagnosticsQuery(client);
  // The Diagnostics tab alone honors the URL's provenance filters; the queue and dead-letter
  // views keep reading the unfiltered fleet-wide report. With no filter both share one cache entry.
  const provenanceFilters = $derived(readProvenanceFilters(router.search));
  const diagnosticsTabQuery = taskDiagnosticsQuery(client, () => provenanceFilters);
  const selectedTaskId = $derived(router.search.get('task') ?? '');
  const taskDetailQuery = taskLedgerDetailQuery(client, () => selectedTaskId);
  const workerIds = $derived(
    (workersQuery.data?.items ?? []).map((worker) => worker.id).toSorted(),
  );
  const manifestQuery = createQuery(() => ({
    queryKey: queryKeys.workers.manifests(workerIds),
    queryFn: () => loadFleetManifestDiagnostics(client, workerIds),
    enabled: !locked && !workersQuery.isPending,
    refetchInterval: 30_000,
  }));
  // Worker detail's contract verification (COR-162); shared with System → Registry.
  const registryQuery = createQuery(() => ({
    queryKey: queryKeys.registrySnapshot(),
    queryFn: () => loadRegistrySnapshot(client),
    enabled: !locked && router.search.get('worker') !== null,
    refetchInterval: 30_000,
  }));
  const rejectionsQuery = createQuery(() => ({
    queryKey: queryKeys.workers.rejections(),
    queryFn: () => loadWorkerRegistrationRejections(client),
    enabled: !locked,
    refetchInterval: 30_000,
  }));

  $effect(() => {
    if (
      isForbidden(workersQuery.error) ||
      isForbidden(queuesQuery.error) ||
      isForbidden(diagnosticsQuery.error) ||
      isForbidden(diagnosticsTabQuery.error) ||
      isForbidden(manifestQuery.error) ||
      isForbidden(rejectionsQuery.error)
    ) {
      principalStore.denyScope('system:read');
    }
  });

  type TabId = 'fleet' | 'list' | 'queues' | 'deployments' | 'diagnostics' | 'conformance';
  const TAB_IDS: readonly TabId[] = [
    'fleet',
    'list',
    'queues',
    'deployments',
    'diagnostics',
    'conformance',
  ];
  const TAB_LABELS: Readonly<Record<TabId, string>> = {
    fleet: 'Fleet overview',
    list: 'Workers',
    queues: 'Task queues',
    deployments: 'Deployments',
    diagnostics: 'Diagnostics',
    conformance: 'Conformance',
  };

  function isTabId(value: string | null): value is TabId {
    return value !== null && (TAB_IDS as readonly string[]).includes(value);
  }

  const activeTab = $derived<TabId>(
    isTabId(router.search.get('tab')) ? (router.search.get('tab') as TabId) : 'fleet',
  );
  const selectedWorkerId = $derived(router.search.get('worker'));
  const selectedQueueName = $derived(router.search.get('queue'));

  function selectTab(next: string): void {
    const params = new URLSearchParams();
    params.set('tab', next);
    router.navigate(`/workers?${params.toString()}`);
  }

  function applyProvenanceFilters(filters: TaskProvenanceFilters): void {
    const params = writeProvenanceFilters(new URLSearchParams({ tab: 'diagnostics' }), filters);
    router.navigate(`/workers?${params.toString()}`);
  }

  function selectTask(operationId: string): void {
    const params = new URLSearchParams();
    params.set('tab', 'diagnostics');
    params.set('task', operationId);
    router.navigate(`/workers?${params.toString()}`);
  }

  // ---------------------------------------------------------------------
  // Mutations + dialogs
  // ---------------------------------------------------------------------
  function refetchAll(): void {
    invalidateWorkerSurfaceQueries(queryClient);
    if (selectedTaskId) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(selectedTaskId) });
    }
  }

  const drainWorker = drainWorkerMutation(client, refetchAll);
  const resumeWorker = resumeWorkerMutation(client, refetchAll);
  const drainDeployment = drainDeploymentMutation(client, refetchAll);
  const resumeDeployment = resumeDeploymentMutation(client, refetchAll);
  const clearDeadLetterAction = clearDeadLetterMutation(client, refetchAll);

  let drainDialogOpen = $state(false);
  let drainTarget = $state<DrainTarget | null>(null);

  function openDrainDialog(target: DrainTarget): void {
    drainTarget = target;
    drainDialogOpen = true;
  }

  function handleDrainConfirm(reason: string | undefined): void {
    if (!drainTarget) return;
    if (drainTarget.kind === 'worker') {
      drainWorker.mutate({
        workerId: drainTarget.id,
        ...(reason !== undefined ? { reason } : {}),
      });
    } else if (drainTarget.kind === 'deployment') {
      drainDeployment.mutate({
        deploymentName: drainTarget.name,
        ...(reason !== undefined ? { reason } : {}),
      });
    }
    drainDialogOpen = false;
  }

  function resumeWorkerById(workerId: string): void {
    resumeWorker.mutate({ workerId });
  }

  function resumeDeploymentByName(deploymentName: string): void {
    resumeDeployment.mutate({ deploymentName });
  }

  let clearDialogOpen = $state(false);
  let clearOperationId = $state<string | null>(null);

  function openClearDialog(operationId: string): void {
    clearOperationId = operationId;
    selectTask(operationId);
    clearDialogOpen = true;
  }

  function handleClearConfirm(): void {
    if (!clearOperationId) return;
    clearDeadLetterAction.mutate({ operationId: clearOperationId });
    clearDialogOpen = false;
  }

  // ---------------------------------------------------------------------
  // Derived view slices
  // ---------------------------------------------------------------------
  const longPollWorkerCount = $derived(
    countByTransport(workersQuery.data?.items ?? [])['long-poll'],
  );
  const selectedWorker = $derived(
    selectedWorkerId
      ? ((workersQuery.data?.items ?? []).find((worker) => worker.id === selectedWorkerId) ?? null)
      : null,
  );
  const selectedWorkerManifest = $derived(
    selectedWorkerId && manifestQuery.data
      ? (manifestQuery.data.find((entry) => entry.instance.workerId === selectedWorkerId) ?? null)
      : undefined,
  );

  const selectedQueue = $derived(
    selectedQueueName
      ? ((queuesQuery.data?.items ?? []).find((queue) => queue.queue === selectedQueueName) ?? null)
      : null,
  );

  const workersOnSelectedQueue = $derived(
    selectedQueueName
      ? (workersQuery.data?.items ?? []).filter((worker) => worker.queue === selectedQueueName)
      : [],
  );

  const deadLetteredOnSelectedQueue = $derived(
    selectedQueueName
      ? (diagnosticsQuery.data?.items ?? []).filter(
          (item) => item.kind === 'dead-lettered' && item.queue === selectedQueueName,
        )
      : [],
  );
  const diagnosticsOnSelectedQueue = $derived(
    selectedQueueName
      ? (diagnosticsQuery.data?.items ?? []).filter((item) => item.queue === selectedQueueName)
      : [],
  );

  // Each tab gates on its OWN query, not a blanket loading/error state for
  // the whole route — a failure fetching, say, task queues must not hide an
  // already-successful Diagnostics tab behind a shared error screen.
  const fleetLoading = $derived(workersQuery.isPending);
  const fleetError = $derived(workersQuery.error ?? null);
  const queuesLoading = $derived(queuesQuery.isPending);
  const queuesError = $derived(queuesQuery.error ?? null);
  const diagnosticsLoading = $derived(diagnosticsTabQuery.isPending);
  const diagnosticsErrorValue = $derived(diagnosticsTabQuery.error ?? null);
</script>

<div class="weft-workers-route">
  <div class="weft-workers-route__header">
    <h1 class="weft-workers-route__title">Workers</h1>
    <WorkersLiveStatus {locked} longPollWorkers={longPollWorkerCount} />
  </div>

  {#if locked}
    <EmptyState title="Workers are locked" description={scopeReason('system:read')}>
      {#snippet icon()}
        <Lock size={28} aria-hidden="true" />
      {/snippet}
    </EmptyState>
  {:else}
    <Tabs value={activeTab} onValueChange={(next) => selectTab(next)}>
      <TabList label="Workers views">
        {#each TAB_IDS as id (id)}
          <Tab value={id}>{TAB_LABELS[id]}</Tab>
        {/each}
      </TabList>

      <TabPanel value="fleet">
        {#if fleetLoading}
          <div
            class="weft-workers-route__skeleton"
            role="status"
            aria-busy="true"
            aria-label="Loading fleet"
          >
            <Skeleton height="1.5rem" width="40%" />
            <Skeleton height="8rem" />
          </div>
        {:else if fleetError}
          <EmptyState
            title={FAULT_TREATMENT_TITLE[faultTreatment(fleetError).kind]}
            description={faultTreatment(fleetError).message}
          />
        {:else}
          <FleetView
            workers={workersQuery.data?.items ?? []}
            deployments={workersQuery.data?.deployments ?? []}
            {adminGate}
            onDrainDeployment={(name) => openDrainDialog({ kind: 'deployment', name })}
            onResumeDeployment={resumeDeploymentByName}
            manifestDiagnostics={manifestQuery.data ?? []}
            registrationRejections={rejectionsQuery.data ?? []}
            manifestLoading={manifestQuery.isPending || rejectionsQuery.isPending}
            manifestRefreshing={(manifestQuery.isFetching && manifestQuery.data !== undefined) ||
              (rejectionsQuery.isFetching && rejectionsQuery.data !== undefined)}
            manifestError={manifestQuery.error ?? rejectionsQuery.error ?? null}
          />
        {/if}
      </TabPanel>

      <TabPanel value="list">
        {#if fleetLoading}
          <div
            class="weft-workers-route__skeleton"
            role="status"
            aria-busy="true"
            aria-label="Loading workers"
          >
            <Skeleton height="1.5rem" width="40%" />
            <Skeleton height="8rem" />
          </div>
        {:else if fleetError}
          <EmptyState
            title={FAULT_TREATMENT_TITLE[faultTreatment(fleetError).kind]}
            description={faultTreatment(fleetError).message}
          />
        {:else if selectedWorker}
          <WorkerDetailView
            worker={selectedWorker}
            {adminGate}
            onDrain={() => openDrainDialog({ kind: 'worker', id: selectedWorker.id })}
            onResume={() => resumeWorkerById(selectedWorker.id)}
            manifestDiagnostics={selectedWorkerManifest}
            manifestLoading={manifestQuery.isPending}
            manifestRefreshing={manifestQuery.isFetching && manifestQuery.data !== undefined}
            manifestError={manifestQuery.error ?? null}
            registry={registryQuery.data}
            registryLoading={registryQuery.isPending}
            registryRefreshing={registryQuery.isFetching && registryQuery.data !== undefined}
            registryError={registryQuery.error ?? null}
          />
        {:else if selectedWorkerId}
          <EmptyState
            title="Worker closed"
            description={`No worker with the id ${selectedWorkerId} is registered with the server. It has closed, or it never connected here.`}
          >
            {#snippet action()}
              <Button
                variant="secondary"
                size="sm"
                label="Back to all workers"
                onclick={() => selectTab('list')}
              />
            {/snippet}
          </EmptyState>
        {:else}
          <WorkerListView workers={workersQuery.data?.items ?? []} />
        {/if}
      </TabPanel>

      <TabPanel value="queues">
        {#if queuesLoading}
          <div
            class="weft-workers-route__skeleton"
            role="status"
            aria-busy="true"
            aria-label="Loading task queues"
          >
            <Skeleton height="1.5rem" width="40%" />
            <Skeleton height="8rem" />
          </div>
        {:else if queuesError}
          <EmptyState
            title={FAULT_TREATMENT_TITLE[faultTreatment(queuesError).kind]}
            description={faultTreatment(queuesError).message}
          />
        {:else if selectedQueue}
          {#await loadQueueDetailView()}
            <div role="status" aria-busy="true" aria-label="Loading task queue detail">
              <Skeleton height="12rem" />
            </div>
          {:then { default: QueueDetailView }}
            <QueueDetailView
              queue={selectedQueue}
              routingPolicy={workersQuery.data?.routingPolicy ?? 'least-loaded'}
              workersOnQueue={workersOnSelectedQueue}
              deadLetteredItems={deadLetteredOnSelectedQueue}
              diagnosticItems={diagnosticsOnSelectedQueue}
              {adminGate}
              onClearDeadLetter={openClearDialog}
              onInspectTask={selectTask}
            />
          {/await}
        {:else}
          <QueueListView
            queues={queuesQuery.data?.items ?? []}
            diagnostics={diagnosticsQuery.data?.items ?? []}
          />
        {/if}
      </TabPanel>

      <TabPanel value="diagnostics">
        {#if !selectedTaskId}
          <DiagnosticsFilterBar
            filters={provenanceFilters}
            onApply={applyProvenanceFilters}
            onClear={() => applyProvenanceFilters({})}
          />
        {/if}
        {#if diagnosticsLoading}
          <div
            class="weft-workers-route__skeleton"
            role="status"
            aria-busy="true"
            aria-label="Loading diagnostics"
          >
            <Skeleton height="1.5rem" width="40%" />
            <Skeleton height="8rem" />
          </div>
        {:else if diagnosticsErrorValue}
          <EmptyState
            title={FAULT_TREATMENT_TITLE[faultTreatment(diagnosticsErrorValue).kind]}
            description={faultTreatment(diagnosticsErrorValue).message}
          />
        {:else if selectedTaskId}
          {#await loadTaskLedgerDetailView()}
            <div role="status" aria-busy="true" aria-label="Loading task ledger view">
              <Skeleton height="12rem" />
            </div>
          {:then { default: TaskLedgerPanel }}
            <TaskLedgerPanel
              loading={taskDetailQuery.isPending}
              error={taskDetailQuery.error ?? null}
              task={taskDetailQuery.data}
              now={Date.now()}
              refreshing={taskDetailQuery.isFetching}
              staleHeartbeatAfterMs={TASK_HEARTBEAT_STALE_AFTER_MS}
            />
          {/await}
          {#if taskDetailQuery.data}
            <TaskDeliveryHistory operationId={selectedTaskId} />
            {#if taskDetailQuery.data.state === 'deadLettered'}
              <TaskDeadLetterPanel task={taskDetailQuery.data} />
            {/if}
          {/if}
        {:else}
          {#await loadDiagnosticsView()}
            <div role="status" aria-busy="true" aria-label="Loading diagnostics view">
              <Skeleton height="12rem" />
            </div>
          {:then { default: DiagnosticsView }}
            <DiagnosticsView
              filtered={hasProvenanceFilters(provenanceFilters)}
              items={diagnosticsTabQuery.data?.items ?? []}
              summary={diagnosticsTabQuery.data?.summary ?? {
                stuckQueued: 0,
                staleInflight: 0,
                retryStorms: 0,
                allWorkersAtCapacity: 0,
                deadLettered: 0,
                delayed: 0,
                unadoptedTerminal: 0,
              }}
              now={Date.now()}
              onInspectTask={selectTask}
            />
          {/await}
        {/if}
      </TabPanel>

      <TabPanel value="deployments">
        <DeploymentsPanel workers={workersQuery.data?.items ?? []} />
      </TabPanel>

      <TabPanel value="conformance">
        <ConformancePanel />
      </TabPanel>
    </Tabs>
  {/if}
</div>

{#if drainTarget}
  <DrainDialog
    bind:open={drainDialogOpen}
    target={drainTarget}
    submitting={drainWorker.isPending || drainDeployment.isPending}
    onDrain={handleDrainConfirm}
    onCancel={() => (drainDialogOpen = false)}
  />
{/if}

{#if clearOperationId}
  <ClearDeadLetterDialog
    bind:open={clearDialogOpen}
    operationId={clearOperationId}
    submitting={clearDeadLetterAction.isPending}
    task={taskDetailQuery.data}
    onConfirm={handleClearConfirm}
    onCancel={() => (clearDialogOpen = false)}
  />
{/if}
