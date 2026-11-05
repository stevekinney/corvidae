<script lang="ts">
  /**
   * Workers route root (plan §9.4, §13 T5.1–T5.4): the Workers list with the open worker and the
   * tasks on its queue beside it (COR-2018, design rows 78g to 79i), and, behind an Advanced
   * disclosure that stays closed until an address asks for it (`?tab=`), the Task queues /
   * Deployments / Diagnostics / Conformance tabs and the open worker's technical details (manifest,
   * session, contract verification, deployment). Everything is URL-owned (`?worker=`, `?tab=`,
   * `?queue=`) per plan §4 "URL owns filter/pagination/tab state". Owns the list queries, every
   * mutation, and the drain/forget/clear-dead-letter dialogs; view components stay presentational.
   * A drain is confirmed against the worker (or deployment) as it was when the dialog opened, and
   * refused if it changed.
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
  import HealthFrame from '../health/health-frame.svelte';
  import { Alert, Collapsible, Skeleton, Tab, TabList, TabPanel, Tabs } from '@lostgradient/cinder';

  import { createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { onDestroy } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';

  import { useFleetEventsLive } from '../../app/live-polling.svelte.ts';
  import { dismissToast, showFault, showToast } from '../../app/toast-host.svelte';
  import { getClient } from '../../lib/client.ts';
  import { faultTreatment } from '../../lib/faults.ts';
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
  import RetryDeadLetterDialog from './retry-dead-letter-dialog.svelte';
  import {
    deadLetterTarget,
    deadLetterTargetFromDetail,
    retryRefusalMessage,
    sameDeadLetter,
    type DeadLetterTarget,
  } from './dead-letter-guard.ts';
  import ConformancePanel from './conformance-panel.svelte';
  import DeploymentsPanel from './deployments-panel.svelte';
  import DiagnosticsFilterBar from './diagnostics-filter-bar.svelte';
  import InProcessNotice from './in-process-notice.svelte';
  import { runsInProcessOnly } from './in-process-engine.ts';
  import TaskDeadLetterPanel from './task-dead-letter-panel.svelte';
  import TaskDeliveryHistory from './task-delivery-history.svelte';
  import QueueListView from './queue-list-view.svelte';
  import { countByTransport, workersSummaryLine } from './worker-presentation.ts';
  import { WORKER_COPY } from './worker-copy.ts';
  import WorkerConfirmations, { type WorkerConfirmation } from './worker-confirmations.svelte';
  import WorkerQueueTasks from './worker-queue-tasks.svelte';
  import WorkerTechnicalDetails from './worker-technical-details.svelte';
  import TaskPayloadDialog from './task-payload-dialog.svelte';
  import { TaskClearController } from './queue-task-clear.svelte.ts';
  import {
    invalidateQueueTaskQueries,
    queueTasksQuery,
    retryAllMutation,
    type QueueTask,
    type QueueTaskTab,
  } from './queue-tasks-data.ts';
  import WorkersListDetail from './workers-list-detail.svelte';
  import ManifestDiagnosticsView from './manifest-diagnostics-view.svelte';
  import type { WorkerManifestDiagnostics } from './worker-manifest-diagnostics.ts';
  import WorkerDiagnosticsSection from './worker-diagnostics-section.svelte';
  import WorkersLiveStatus from './workers-live-status.svelte';
  import {
    hasProvenanceFilters,
    readProvenanceFilters,
    writeProvenanceFilters,
  } from './provenance-filters.ts';
  import {
    TASK_HEARTBEAT_STALE_AFTER_MS,
    type TaskProvenanceFilters,
    type WorkerSummary,
  } from './worker-catalog-types.ts';
  import {
    clearDeadLetterMutation,
    drainDeploymentMutation,
    drainWorkerMutation,
    forgetWorkerMutation,
    resumeDeploymentMutation,
    resumeWorkerMutation,
    retryDeadLetterMutation,
    taskDiagnosticsQuery,
    taskLedgerDetailQuery,
    taskQueuesListQuery,
    workersListQuery,
    loadFleetManifestDiagnostics,
    loadRegistrySnapshot,
    loadWorkerRegistrationRejections,
    invalidateDeadLetterQueries,
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

  type TabId = 'queues' | 'deployments' | 'diagnostics' | 'conformance';
  const TAB_IDS: readonly TabId[] = ['queues', 'deployments', 'diagnostics', 'conformance'];
  const TAB_LABELS: Readonly<Record<TabId, string>> = {
    queues: 'Task queues',
    deployments: 'Deployments',
    diagnostics: 'Diagnostics',
    conformance: 'Conformance',
  };

  function isTabId(value: string | null): value is TabId {
    return value !== null && (TAB_IDS as readonly string[]).includes(value);
  }

  const activeTab = $derived<TabId>(
    isTabId(router.search.get('tab')) ? (router.search.get('tab') as TabId) : 'queues',
  );
  // Advanced is closed until an address asks for one of its tabs, and stays as the person left it.
  let advancedOpen = $state(router.search.has('tab') || router.search.has('queue'));
  $effect(() => {
    if (router.search.has('tab') || router.search.has('queue')) advancedOpen = true;
  });
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
      void invalidateDeadLetterQueries(queryClient, selectedTaskId);
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

  const CLEAR_REFUSAL =
    'That dead letter was cleared or changed, so nothing was cleared. Check how the queue is now, then clear it again if you still mean to.';
  const RETRY_REFUSAL =
    'That dead letter was cleared, retried or changed, so nothing was retried. Check how it is now, then retry it again if you still mean to.';

  /**
   * Where a dead letter was read from, which is also where it is read again at confirmation: the
   * queue view reads the diagnostics list; a task's ledger reads the task, so it reaches a dead
   * letter the diagnostics do not list (one on a queue the queue list omits, or beyond the page).
   */
  type DeadLetterSource = 'diagnostics' | 'ledger';
  interface DeadLetterDialog {
    readonly source: DeadLetterSource;
    readonly target: DeadLetterTarget;
  }

  let clearDialogOpen = $state(false);
  let clearDialog = $state<DeadLetterDialog | null>(null);
  let clearRefusal = $state<string | null>(null);
  let retryDialogOpen = $state(false);
  let retryDialog = $state<DeadLetterDialog | null>(null);
  let retryRefusal = $state<string | null>(null);
  const retryDeadLetterAction = retryDeadLetterMutation(client, queryClient, {
    onSettled: refetchAll,
    onRefused: (error) => {
      retryRefusal = retryRefusalMessage(error);
      if (isForbidden(error)) principalStore.denyScope('system:admin');
    },
  });

  // The dead letter as it reads now; a clear or retry is confirmed against the one read when its
  // dialog opened, so a dead letter that was cleared, retried or re-recorded meanwhile is refused.
  function currentDeadLetter(
    source: DeadLetterSource,
    operationId: string,
  ): DeadLetterTarget | null {
    if (source === 'ledger') {
      const task = taskDetailQuery.data;
      return task?.operationId === operationId ? deadLetterTargetFromDetail(task) : null;
    }
    return deadLetterTarget(diagnosticsQuery.data?.items ?? [], operationId);
  }

  function openClearDialog(source: DeadLetterSource, observed: DeadLetterTarget | null): void {
    clearRefusal = null;
    clearDialog = observed === null ? null : { source, target: observed };
    clearDialogOpen = clearDialog !== null;
    if (clearDialog === null) clearRefusal = CLEAR_REFUSAL;
  }

  function handleClearConfirm(): void {
    const dialog = clearDialog;
    if (!dialog) return;
    clearDialogOpen = false;
    const { source, target } = dialog;
    if (!sameDeadLetter(target, currentDeadLetter(source, target.operationId))) {
      clearRefusal = CLEAR_REFUSAL;
      return;
    }
    clearDeadLetterAction.mutate({ operationId: target.operationId });
  }

  // The task a retry is in flight for: its Retry stays disabled until the retry, and the refetch it
  // asks for, have settled, so a second click cannot send a second request.
  const retryingOperationId = $derived(
    retryDeadLetterAction.isPending ? retryDeadLetterAction.variables?.operationId : undefined,
  );

  function openRetryDialog(source: DeadLetterSource, observed: DeadLetterTarget | null): void {
    retryRefusal = null;
    retryDialog = observed === null ? null : { source, target: observed };
    retryDialogOpen = retryDialog !== null;
    if (retryDialog === null) retryRefusal = RETRY_REFUSAL;
  }

  function handleRetryConfirm(): void {
    const dialog = retryDialog;
    if (!dialog) return;
    retryDialogOpen = false;
    const { source, target } = dialog;
    if (!sameDeadLetter(target, currentDeadLetter(source, target.operationId))) {
      retryRefusal = RETRY_REFUSAL;
      return;
    }
    retryDeadLetterAction.mutate({
      operationId: target.operationId,
      ...(target.attemptTokenDigest !== undefined
        ? { attemptTokenDigest: target.attemptTokenDigest }
        : {}),
    });
  }

  // ---------------------------------------------------------------------
  // The open worker and the tasks on its queue (COR-2018)
  // ---------------------------------------------------------------------
  const openWorkerId = $derived(router.search.get('worker'));
  const openWorker = $derived(
    openWorkerId === null
      ? undefined
      : (workersQuery.data?.items ?? []).find((worker) => worker.id === openWorkerId),
  );
  const openQueue = $derived(openWorker?.queue);

  // The tab the person chose for this queue; until they choose, the failed tasks when there are
  // any, since they are what needs a person, and every task otherwise.
  let chosenTab = $state<{ readonly queue: string; readonly tab: QueueTaskTab } | null>(null);
  // The queue's counts, from the tab that lists every task, which is also the tab that is open
  // unless the person chose another: they share one cache entry.
  const countsQuery = queueTasksQuery(
    client,
    () => openQueue,
    () => 'all',
  );
  const rawCounts = $derived(countsQuery.data?.pages[0]?.counts);
  const tasksTab = $derived<QueueTaskTab>(
    chosenTab !== null && chosenTab.queue === openQueue
      ? chosenTab.tab
      : rawCounts !== undefined && rawCounts.failed > 0
        ? 'failed'
        : 'all',
  );
  const tasksQuery = queueTasksQuery(
    client,
    () => openQueue,
    () => tasksTab,
  );

  // A clear that is held for its Undo takes its tasks out of the lists and the counts.
  const retryingIds = new SvelteSet<string>();
  const clearer = new TaskClearController({
    clear: (operationId) =>
      client.operations['weft.tasks.diagnostics.deadletters.clear']({ operationId }),
    announce: (message, undo) => showToast(message, { undo }),
    dismiss: dismissToast,
    refresh: () => invalidateQueueTaskQueries(queryClient),
    refused: (errors) => showFault(faultTreatment(errors[0])),
  });
  // Leaving the page commits what is held: an Undo must not outlive the page it would undo on.
  onDestroy(() => void clearer.flush());
  $effect(() => {
    const commit = (): void => void clearer.flush();
    window.addEventListener('pagehide', commit);
    return () => window.removeEventListener('pagehide', commit);
  });

  const counts = $derived(
    rawCounts === undefined || openQueue === undefined
      ? undefined
      : {
          waiting: rawCounts.waiting,
          failed: Math.max(0, rawCounts.failed - clearer.hiddenCount(openQueue)),
        },
  );
  const tasks = $derived<readonly QueueTask[]>(
    (tasksQuery.data?.pages ?? [])
      .flatMap((page) => page.items)
      .filter((task) => !clearer.hidden.has(task.operationId)),
  );

  const retryAll = retryAllMutation(client, queryClient);

  /** Every failed task on the open queue, reading the pages the list has not loaded yet. */
  async function failedTasksOnQueue(queue: string): Promise<readonly QueueTask[]> {
    const found: QueueTask[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.operations['weft.task.queues.tasks']({
        queue,
        status: 'failed',
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      found.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return found.filter((task) => !clearer.hidden.has(task.operationId));
  }

  async function retryTasks(queue: string, operationIds: readonly string[]): Promise<void> {
    if (operationIds.length === 0) return;
    for (const operationId of operationIds) retryingIds.add(operationId);
    try {
      const result = await retryAll.mutateAsync(operationIds);
      if (result.retried > 0) {
        showToast(WORKER_COPY.tasks.retried(result.retried, queue), { variant: 'info' });
      }
      if (result.refused.length > 0) showFault(faultTreatment(result.refused[0]));
    } catch (error) {
      showFault(faultTreatment(error));
    } finally {
      for (const operationId of operationIds) retryingIds.delete(operationId);
    }
  }

  async function retryAllFailed(): Promise<void> {
    if (openQueue === undefined) return;
    const queue = openQueue;
    const failed = await failedTasksOnQueue(queue);
    await retryTasks(
      queue,
      failed.map((task) => task.operationId),
    );
  }

  async function clearAllFailed(): Promise<void> {
    if (openQueue === undefined) return;
    const queue = openQueue;
    const failed = await failedTasksOnQueue(queue);
    clearer.stage(
      queue,
      failed.map((task) => task.operationId),
      WORKER_COPY.tasks.cleared(failed.length, queue),
    );
  }

  let payloadTask = $state<{ operationId: string; name: string } | null>(null);

  // Drain and Forget confirm first. A drain is confirmed against the worker as it was when the
  // dialog opened, so one that changed meanwhile is refused (`drain-guard.ts`).
  let confirmation = $state<WorkerConfirmation | null>(null);
  let confirmationObserved = $state<DrainFingerprint | null>(null);
  const forgetWorker = forgetWorkerMutation(client, refetchAll);

  function openConfirmation(next: WorkerConfirmation): void {
    drainRefusal = null;
    confirmationObserved = drainFingerprint(workersQuery.data?.items ?? [], {
      kind: 'worker',
      id: next.worker.id,
    });
    confirmation = next;
  }

  function confirmWorkerAction(): void {
    const current = confirmation;
    if (current === null) return;
    confirmation = null;
    const { worker } = current;
    if (
      drainFingerprint(workersQuery.data?.items ?? [], { kind: 'worker', id: worker.id }) !==
      confirmationObserved
    ) {
      drainRefusal = `That worker changed while the dialog was open, so nothing was ${
        current.kind === 'drain' ? 'drained' : 'forgotten'
      }. Check how it is now, then try again if you still mean to.`;
      return;
    }
    if (current.kind === 'drain') {
      drainWorker.mutate({ workerId: worker.id });
      return;
    }
    forgetWorker.mutate(
      { workerId: worker.id },
      {
        onSuccess: () => {
          // The worker is gone from the list, so its pane has nothing to show.
          if (router.search.get('worker') === worker.id) {
            router.navigate('/health/workers', { replace: true });
          }
        },
      },
    );
  }

  function manifestOf(worker: WorkerSummary): WorkerManifestDiagnostics | null | undefined {
    // Undefined until the fleet's manifests have been read; null when they were, and none is this worker's.
    return (
      manifestQuery.data?.find((entry) => entry.instance.workerId === worker.id) ??
      (manifestQuery.data === undefined ? undefined : null)
    );
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

<HealthFrame active="workers">
  <div class="weft-workers-route">
    {#if drainRefusal !== null}
      <Alert variant="warning" dismissible onDismiss={() => (drainRefusal = null)}
        >{drainRefusal}</Alert
      >
    {/if}

    {#if clearRefusal !== null}
      <Alert variant="warning" dismissible onDismiss={() => (clearRefusal = null)}
        >{clearRefusal}</Alert
      >
    {/if}

    {#if retryRefusal !== null}
      <Alert variant="warning" dismissible onDismiss={() => (retryRefusal = null)}
        >{retryRefusal}</Alert
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
          {counts}
          onDrain={(worker) => openConfirmation({ kind: 'drain', worker })}
          onResume={resumeWorkerById}
          onForget={(worker) => openConfirmation({ kind: 'forget', worker })}
        >
          {#snippet queueTasks(worker)}
            {#key worker.queue}
              <WorkerQueueTasks
                queue={worker.queue}
                tab={tasksTab}
                onTabChange={(next) => (chosenTab = { queue: worker.queue, tab: next })}
                {counts}
                {tasks}
                retrying={retryingIds}
                retryingCount={retryAll.isPending ? retryingIds.size : 0}
                loading={tasksQuery.isPending}
                error={tasksQuery.error ?? null}
                onReload={() => void tasksQuery.refetch()}
                hasMore={tasksQuery.hasNextPage}
                loadingMore={tasksQuery.isFetchingNextPage}
                onLoadMore={async () => {
                  await tasksQuery.fetchNextPage();
                }}
                {adminGate}
                onRetryAll={() => void retryAllFailed()}
                onClearAll={() => void clearAllFailed()}
                onRetry={(operationId) => void retryTasks(worker.queue, [operationId])}
                onClear={(operationId) =>
                  clearer.stage(
                    worker.queue,
                    [operationId],
                    WORKER_COPY.tasks.cleared(1, worker.queue),
                  )}
                onViewPayload={(operationId, name) => (payloadTask = { operationId, name })}
              />
            {/key}
          {/snippet}
        </WorkersListDetail>
      {/if}

      <Collapsible
        open={advancedOpen}
        onToggle={(next) => (advancedOpen = next)}
        chevron="start"
        class="ib-workers-advanced"
        data-testid="workers-advanced"
      >
        {#snippet trigger()}
          <span class="ib-workers-advanced__title">Advanced</span>
          <span class="ib-workers-advanced__summary"
            >Task queues, deployments, diagnostics and conformance</span
          >
        {/snippet}
        {#if advancedOpen}
          <div class="ib-workers-advanced__body">
            {#if !inProcessOnly}
              <WorkersLiveStatus {locked} longPollWorkers={longPollWorkerCount} />
            {/if}
            {#if openWorker !== undefined}
              <WorkerTechnicalDetails
                worker={openWorker}
                {adminGate}
                onDrainDeployment={(name) => openDrainDialog({ kind: 'deployment', name })}
                onResumeDeployment={resumeDeploymentByName}
                manifestDiagnostics={manifestOf(openWorker)}
                manifestLoading={manifestQuery.isPending}
                manifestRefreshing={manifestQuery.isFetching && manifestQuery.data !== undefined}
                manifestError={manifestQuery.error ?? null}
                registry={registryQuery.data}
                registryLoading={registryQuery.isPending}
                registryRefreshing={registryQuery.isFetching && registryQuery.data !== undefined}
                registryError={registryQuery.error ?? null}
              >
                {#snippet deployment(deploymentName)}
                  <DeploymentsPanel workers={workersQuery.data?.items ?? []} {deploymentName} />
                {/snippet}
                {#snippet diagnostics()}
                  <WorkerDiagnosticsSection workerId={openWorker.id} onInspectTask={selectTask} />
                {/snippet}
              </WorkerTechnicalDetails>
            {/if}
            <Tabs value={activeTab} onValueChange={(next) => selectTab(next)}>
              <TabList label="Workers views">
                {#each TAB_IDS as id (id)}
                  <Tab value={id}>{TAB_LABELS[id]}</Tab>
                {/each}
              </TabList>

              <TabPanel value="queues">
                {#if queuesError}
                  <QueryFaultBanner
                    error={queuesError}
                    onRetry={() => void queuesQuery.refetch()}
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
                      {retryingOperationId}
                      onRetryDeadLetter={(operationId) =>
                        openRetryDialog(
                          'diagnostics',
                          deadLetterTarget(diagnosticsQuery.data?.items ?? [], operationId),
                        )}
                      onClearDeadLetter={(operationId) =>
                        openClearDialog(
                          'diagnostics',
                          deadLetterTarget(diagnosticsQuery.data?.items ?? [], operationId),
                        )}
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
                      onRetry={() => void taskDetailQuery.refetch()}
                    />
                  {/await}
                  {#if taskDetailQuery.data}
                    <TaskDeliveryHistory operationId={selectedTaskId} />
                    {#if taskDetailQuery.data.state === 'deadLettered'}
                      <TaskDeadLetterPanel
                        task={taskDetailQuery.data}
                        retrying={retryingOperationId === taskDetailQuery.data.operationId}
                        onRetryDeadLetter={(target) => openRetryDialog('ledger', target)}
                        onClearDeadLetter={(target) => openClearDialog('ledger', target)}
                      />
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
            <ManifestDiagnosticsView
              diagnostics={manifestQuery.data ?? []}
              rejections={rejectionsQuery.data ?? []}
              refreshing={(manifestQuery.isFetching && manifestQuery.data !== undefined) ||
                (rejectionsQuery.isFetching && rejectionsQuery.data !== undefined)}
              loading={manifestQuery.isPending || rejectionsQuery.isPending}
              error={manifestQuery.error ?? rejectionsQuery.error ?? null}
            />
          </div>
        {/if}
      </Collapsible>
    {/if}
  </div>
</HealthFrame>

{#if confirmation !== null}
  <WorkerConfirmations
    {confirmation}
    workers={workersQuery.data?.items ?? []}
    {counts}
    busy={drainWorker.isPending || forgetWorker.isPending}
    onConfirm={confirmWorkerAction}
    onCancel={() => (confirmation = null)}
  />
{/if}

<TaskPayloadDialog task={payloadTask} onClose={() => (payloadTask = null)} />

{#if drainTarget}
  <DrainDialog
    bind:open={drainDialogOpen}
    target={drainTarget}
    submitting={drainWorker.isPending || drainDeployment.isPending}
    onDrain={handleDrainConfirm}
    onCancel={() => (drainDialogOpen = false)}
  />
{/if}

{#if clearDialog}
  <ClearDeadLetterDialog
    bind:open={clearDialogOpen}
    target={clearDialog.target}
    submitting={clearDeadLetterAction.isPending}
    onConfirm={handleClearConfirm}
    onCancel={() => (clearDialogOpen = false)}
  />
{/if}

{#if retryDialog}
  <RetryDeadLetterDialog
    bind:open={retryDialogOpen}
    target={retryDialog.target}
    submitting={retryDeadLetterAction.isPending}
    onConfirm={handleRetryConfirm}
    onCancel={() => (retryDialogOpen = false)}
  />
{/if}
