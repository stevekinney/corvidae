<script lang="ts">
  /**
   * Workers route root (plan §9.4, §13 T5.1–T5.4): the Workers list with the open worker beside it
   * (design rows 20c and 19a), then Task queues / Deployments / Diagnostics / Conformance tabs,
   * URL-owned (`?tab=`, `?worker=`, `?queue=`) per plan §4 "URL owns filter/pagination/tab
   * state". Workers is the default tab. Owns the list queries, every mutation, and the
   * drain/clear-dead-letter dialogs; view components stay presentational. A drain is confirmed
   * against the worker (or deployment) as it was when the dialog opened, and refused if it changed.
   *
   * ## Live connect/disconnect (plan §9.4 T5.1)
   *
   * An `Alert` gates the whole surface on `system:read`. The shell
   * applies the shell's ONE shared `FleetEventSource`
   * (`src/app/engine-status.svelte.ts`) to the cache for every page, so a
   * worker connecting, leaving or being refused, a deployment changing, or a
   * workflow definition registering asks the queries below again
   * (`../../lib/live-source/cache-integration.ts`), and their 30s poll
   * (`workers-data.ts`'s `REFETCH_INTERVAL_MS`) runs only while that feed is
   * not live: it is the "polling fallback" half of the requirement. The opt-in
   * "Live" toggle (default OFF per plan §5 UI treatment) subscribes to the
   * same source for what the shell's mapping leaves out, invalidating the
   * queues and the diagnostics too on `worker:connected`/`worker:disconnected`.
   * Neither constructs or closes a connection of its own, per plan §5's "one
   * fleet SSE … never per-row/per-surface connections" budget.
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
  import { Alert, PageHeader, Skeleton, Tab, TabList, TabPanel, Tabs } from '@lostgradient/cinder';

  import { createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { useFleetEventsLive } from '../../app/live-polling.svelte.ts';
  import { getClient } from '../../lib/client.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import {
    getPrincipalStore,
    isForbidden,
    scopeGate,
    scopeReason,
  } from '../../lib/scopes.svelte.ts';
  import QueryFaultBanner from '../system/query-fault-banner.svelte';
  import type { DrainTarget } from './drain-dialog.svelte';
  import DrainDialog from './drain-dialog.svelte';
  import { drainFingerprint, type DrainFingerprint } from './drain-guard.ts';
  import ClearDeadLetterDialog from './clear-dead-letter-dialog.svelte';
  import ConformancePanel from './conformance-panel.svelte';
  import DeploymentsPanel from './deployments-panel.svelte';
  import DiagnosticsFilterBar from './diagnostics-filter-bar.svelte';
  import InProcessNotice from './in-process-notice.svelte';
  import { runsInProcessOnly } from './in-process-engine.ts';
  import TaskDeadLetterPanel from './task-dead-letter-panel.svelte';
  import TaskDeliveryHistory from './task-delivery-history.svelte';
  import QueueListView from './queue-list-view.svelte';
  import { countByTransport, workersSummaryLine } from './worker-presentation.ts';
  import WorkersListDetail from './workers-list-detail.svelte';
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
  // These three ask again when the fleet feed reports a worker connecting, leaving or being
  // refused, or a workflow definition being registered, and poll only while that feed is not live.
  const fleetLive = useFleetEventsLive();
  const manifestQuery = createQuery(() => {
    const polling = !fleetLive();
    return {
      queryKey: queryKeys.workers.manifests(workerIds),
      queryFn: () => loadFleetManifestDiagnostics(client, workerIds),
      enabled: !locked && !workersQuery.isPending,
      // poll-reason: fallback
      refetchInterval: polling ? 30_000 : false,
    };
  });
  // Worker detail's contract verification (COR-162); shared with System → Registry.
  const registryQuery = createQuery(() => {
    const polling = !fleetLive();
    return {
      queryKey: queryKeys.registrySnapshot(),
      queryFn: () => loadRegistrySnapshot(client),
      enabled: !locked && router.search.get('worker') !== null,
      // poll-reason: fallback
      refetchInterval: polling ? 30_000 : false,
    };
  });
  const rejectionsQuery = createQuery(() => {
    const polling = !fleetLive();
    return {
      queryKey: queryKeys.workers.rejections(),
      queryFn: () => loadWorkerRegistrationRejections(client),
      enabled: !locked,
      // poll-reason: fallback
      refetchInterval: polling ? 30_000 : false,
    };
  });

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

  type TabId = 'workers' | 'queues' | 'deployments' | 'diagnostics' | 'conformance';
  const TAB_IDS: readonly TabId[] = [
    'workers',
    'queues',
    'deployments',
    'diagnostics',
    'conformance',
  ];
  const TAB_LABELS: Readonly<Record<TabId, string>> = {
    workers: 'Workers',
    queues: 'Task queues',
    deployments: 'Deployments',
    diagnostics: 'Diagnostics',
    conformance: 'Conformance',
  };

  function isTabId(value: string | null): value is TabId {
    return value !== null && (TAB_IDS as readonly string[]).includes(value);
  }

  const activeTab = $derived<TabId>(
    isTabId(router.search.get('tab')) ? (router.search.get('tab') as TabId) : 'workers',
  );
  const selectedQueueName = $derived(router.search.get('queue'));

  function selectTab(next: string): void {
    const params = new URLSearchParams();
    params.set('tab', next);
    router.navigate(`/health/workers?${params.toString()}`);
  }

  function applyProvenanceFilters(filters: TaskProvenanceFilters): void {
    const params = writeProvenanceFilters(new URLSearchParams({ tab: 'diagnostics' }), filters);
    router.navigate(`/health/workers?${params.toString()}`);
  }

  function selectTask(operationId: string): void {
    const params = new URLSearchParams();
    params.set('tab', 'diagnostics');
    params.set('task', operationId);
    router.navigate(`/health/workers?${params.toString()}`);
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
  // What the fleet listed for the target when the dialog opened; the drain is refused if it moved.
  let drainObserved = $state<DrainFingerprint | null>(null);
  let drainRefusal = $state<string | null>(null);

  function openDrainDialog(target: DrainTarget): void {
    drainRefusal = null;
    drainObserved = drainFingerprint(workersQuery.data?.items ?? [], target);
    drainTarget = target;
    drainDialogOpen = true;
  }

  function handleDrainConfirm(reason: string | undefined): void {
    if (!drainTarget) return;
    if (drainFingerprint(workersQuery.data?.items ?? [], drainTarget) !== drainObserved) {
      drainDialogOpen = false;
      drainRefusal = `${drainTarget.kind === 'deployment' ? 'That deployment' : 'That worker'} changed while the dialog was open, so nothing was drained. Check how it is now, then drain it again if you still mean to.`;
      return;
    }
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
  // No worker, deployment, queue, or task: the engine runs in-process, and the page says so instead of
  // showing five tabs of zeros. A fleet that has not been read yet, or could not be, is not that.
  // The page is a skeleton until the workers, the queues, and the diagnostics have all answered, so
  // the tabs never appear and then go (or the sentence appear and then give way to them) when one
  // list is quicker than another. A list that failed has settled, and says nothing about the fleet.
  const fleetSettling = $derived(
    workersQuery.isPending || queuesQuery.isPending || diagnosticsQuery.isPending,
  );
  const inProcessOnly = $derived(
    workersQuery.data !== undefined &&
      queuesQuery.data !== undefined &&
      diagnosticsQuery.data !== undefined &&
      runsInProcessOnly(workersQuery.data, queuesQuery.data, diagnosticsQuery.data, router.search),
  );
  const fleetError = $derived(workersQuery.error ?? null);
  const queuesError = $derived(queuesQuery.error ?? null);
  const diagnosticsLoading = $derived(diagnosticsTabQuery.isPending);
  const diagnosticsErrorValue = $derived(diagnosticsTabQuery.error ?? null);
</script>

<div class="weft-workers-route">
  <PageHeader headingLevel={1} title="Workers" />
  {#if !inProcessOnly}
    <WorkersLiveStatus {locked} longPollWorkers={longPollWorkerCount} />
  {/if}

  {#if drainRefusal !== null}
    <Alert variant="warning" dismissible onDismiss={() => (drainRefusal = null)}
      >{drainRefusal}</Alert
    >
  {/if}

  {#if locked}
    <Alert variant="warning">{scopeReason('system:read')} to read the workers.</Alert>
  {:else if fleetSettling}
    <div
      class="weft-workers-route__skeleton"
      role="status"
      aria-busy="true"
      aria-label="Loading fleet"
    >
      <Skeleton height="1.5rem" width="40%" />
      <Skeleton height="8rem" />
    </div>
  {:else if inProcessOnly}
    <InProcessNotice />
  {:else}
    <Tabs value={activeTab} onValueChange={(next) => selectTab(next)}>
      <TabList label="Workers views">
        {#each TAB_IDS as id (id)}
          <Tab value={id}>{TAB_LABELS[id]}</Tab>
        {/each}
      </TabList>

      <TabPanel value="workers">
        {#if fleetError}
          <QueryFaultBanner error={fleetError} onRetry={() => void workersQuery.refetch()} />
        {:else}
          <WorkersListDetail
            workers={workersQuery.data?.items ?? []}
            summary={workersSummaryLine({
              workers: workersQuery.data?.items ?? [],
              waiting: queuesQuery.data?.items.reduce((total, queue) => total + queue.backlog, 0),
              failedForGood: diagnosticsQuery.data?.summary.deadLettered,
            })}
            {adminGate}
            onDrain={(worker) => openDrainDialog({ kind: 'worker', id: worker.id })}
            onResume={resumeWorkerById}
            onDrainDeployment={(name) => openDrainDialog({ kind: 'deployment', name })}
            onResumeDeployment={resumeDeploymentByName}
            onInspectTask={selectTask}
            manifestDiagnostics={manifestQuery.data}
            registrationRejections={rejectionsQuery.data ?? []}
            manifestLoading={manifestQuery.isPending || rejectionsQuery.isPending}
            manifestRefreshing={(manifestQuery.isFetching && manifestQuery.data !== undefined) ||
              (rejectionsQuery.isFetching && rejectionsQuery.data !== undefined)}
            manifestError={manifestQuery.error ?? rejectionsQuery.error ?? null}
            registry={registryQuery.data}
            registryLoading={registryQuery.isPending}
            registryRefreshing={registryQuery.isFetching && registryQuery.data !== undefined}
            registryError={registryQuery.error ?? null}
          />
        {/if}
      </TabPanel>

      <TabPanel value="queues">
        {#if queuesError}
          <QueryFaultBanner error={queuesError} onRetry={() => void queuesQuery.refetch()} />
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
          <QueryFaultBanner
            error={diagnosticsErrorValue}
            onRetry={() => void diagnosticsTabQuery.refetch()}
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
              onClearFilters={() => applyProvenanceFilters({})}
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
