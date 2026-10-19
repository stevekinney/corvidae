<script lang="ts">
  /**
   * The Workers route's Deployments tab (COR-277): reads every deployment's
   * versions and routing pointer, and owns the dialogs and mutations behind the
   * operator actions. Routing changes go through preview, explicit
   * confirmation, and a generation precondition (`routing-dialog.svelte`);
   * build-scoped drain and resume, and removal, call the server's operations
   * for them and report its typed faults. Nothing here decides which build
   * serves a workflow.
   */
  import { Alert, ConfirmDialog, EmptyState, Skeleton } from '@lostgradient/cinder';
  import { WORKER_CONFLICT_REASONS } from '@lostgradient/weft';
  import { useQueryClient } from '@tanstack/svelte-query';
  import Lock from '@lucide/svelte/icons/lock';

  import { getClient } from '../../lib/client.ts';
  import { FAULT_TREATMENT_TITLE, faultTreatment } from '../../lib/faults.ts';
  import {
    getPrincipalStore,
    isForbidden,
    scopeGate,
    scopeReason,
  } from '../../lib/scopes.svelte.ts';
  import {
    applyRoutingMutation,
    conflictReasonOf,
    deploymentOverviewsQuery,
    drainVersionMutation,
    invalidateDeploymentQueries,
    MalformedDeploymentsError,
    previewRoutingChange,
    removeVersionMutation,
    resumeVersionMutation,
    type DeploymentOverview,
    type RoutingAction,
  } from './deployments-data.ts';
  import DeploymentVersionsView from './deployment-versions-view.svelte';
  import { versionRole } from './deployments-presentation.ts';
  import DrainDialog, { type DrainTarget } from './drain-dialog.svelte';
  import RoutingDialog, { type RoutingDialogRequest } from './routing-dialog.svelte';
  import type { WorkerSummary } from './worker-catalog-types.ts';

  interface DeploymentsPanelProps {
    /** The fleet list, so each build can show the workers connected to it. */
    readonly workers: readonly WorkerSummary[];
    /** Reference instant for relative times; defaults to render time. */
    readonly now?: number;
  }

  let { workers, now = Date.now() }: DeploymentsPanelProps = $props();

  const client = getClient();
  const queryClient = useQueryClient();
  const principalStore = getPrincipalStore();
  const adminGate = $derived(scopeGate(principalStore, ['system:admin']));

  const overviewsQuery = deploymentOverviewsQuery(client);
  const refresh = () => invalidateDeploymentQueries(queryClient);
  const applyRouting = applyRoutingMutation(client, refresh);
  let actionError = $state<unknown>(null);
  const reportFailure = (failure: unknown) => (actionError = failure);
  const removeVersion = removeVersionMutation(client, refresh, reportFailure);
  const drainVersion = drainVersionMutation(client, refresh, reportFailure);
  const resumeVersion = resumeVersionMutation(client, refresh, reportFailure);

  $effect(() => {
    if (isForbidden(overviewsQuery.error) && principalStore.hasScope('system:read')) {
      principalStore.denyScope('system:read');
    }
  });

  const overviews = $derived(overviewsQuery.data);
  const error = $derived(overviewsQuery.error);

  function overviewOf(deploymentName: string): DeploymentOverview | undefined {
    return overviews?.find((entry) => entry.deploymentName === deploymentName);
  }

  // ---- routing dialog -------------------------------------------------------------------------
  let routingOpen = $state(false);
  let routingRequest = $state<RoutingDialogRequest>({ kind: 'setrouting', deploymentName: '' });

  function openRouting(request: RoutingDialogRequest): void {
    actionError = null;
    routingRequest = request;
    routingOpen = true;
  }

  const routingOverview = $derived(overviewOf(routingRequest.deploymentName));

  function applyAction(action: RoutingAction, expectedGeneration: number): Promise<unknown> {
    return applyRouting.mutateAsync({ action, expectedGeneration });
  }

  // ---- build drain ----------------------------------------------------------------------------
  let drainOpen = $state(false);
  let drainTarget = $state<DrainTarget>({ kind: 'build', deploymentName: '', buildId: '' });

  function confirmDrain(reason: string | undefined): void {
    if (drainTarget.kind !== 'build') return;
    actionError = null;
    drainVersion.mutate({
      deploymentName: drainTarget.deploymentName,
      buildId: drainTarget.buildId,
      ...(reason === undefined ? {} : { reason }),
    });
    drainOpen = false;
  }

  function resume(deploymentName: string, buildId: string): void {
    actionError = null;
    resumeVersion.mutate({ deploymentName, buildId });
  }

  // ---- removal --------------------------------------------------------------------------------
  let removeOpen = $state(false);
  let removeTarget = $state({ deploymentName: '', buildId: '' });

  function confirmRemove(): void {
    actionError = null;
    removeVersion.mutate(removeTarget);
    removeOpen = false;
  }

  /** What a failed drain, resume, or removal says, branching on the fault's reason, never its text. */
  function actionErrorMessage(failure: unknown): string {
    const reason = conflictReasonOf(failure);
    if (reason === WORKER_CONFLICT_REASONS.versionReferenced) {
      return 'That build is now referenced by an execution, so it was not removed. Reload to see its references.';
    }
    if (reason === WORKER_CONFLICT_REASONS.versionRouted) {
      return 'That build is now a routing target, so it was not removed. Route new traffic to another build first.';
    }
    return faultTreatment(failure).message;
  }
</script>

<div class="weft-deployments-panel">
  {#if actionError !== null}
    <Alert variant="danger">{actionErrorMessage(actionError)}</Alert>
  {/if}

  {#if overviewsQuery.isPending}
    <div role="status" aria-busy="true" aria-label="Loading deployments">
      <Skeleton height="12rem" />
    </div>
  {:else if error && overviews === undefined && isForbidden(error)}
    <EmptyState
      title="Deployments are locked"
      description={`${scopeReason('system:read')} to read deployment versions and routing.`}
    >
      {#snippet icon()}
        <Lock size={28} aria-hidden="true" />
      {/snippet}
    </EmptyState>
  {:else if error && overviews === undefined && error instanceof MalformedDeploymentsError}
    <EmptyState title="Malformed server response" description={error.message} />
  {:else if error && overviews === undefined}
    {@const treatment = faultTreatment(error)}
    <EmptyState title={FAULT_TREATMENT_TITLE[treatment.kind]} description={treatment.message} />
  {:else if overviews}
    {#if error}
      <Alert variant="warning"
        >Refreshing deployments failed, so this is the last successful read. {faultTreatment(error)
          .message}</Alert
      >
    {/if}
    <DeploymentVersionsView
      {overviews}
      {workers}
      {adminGate}
      {now}
      onSetRouting={(deploymentName) => openRouting({ kind: 'setrouting', deploymentName })}
      onMove={(kind, deploymentName, buildId) => openRouting({ kind, deploymentName, buildId })}
      onDrain={(deploymentName, buildId) => {
        drainTarget = { kind: 'build', deploymentName, buildId };
        drainOpen = true;
      }}
      onResume={resume}
      onRemove={(deploymentName, buildId) => {
        removeTarget = { deploymentName, buildId };
        removeOpen = true;
      }}
    />
  {/if}
</div>

<RoutingDialog
  bind:open={routingOpen}
  request={routingRequest}
  versions={routingOverview?.versions ?? []}
  initial={{
    currentBuildId: routingOverview?.routing?.currentBuildId,
    rampingBuildId: routingOverview?.routing?.rampingBuildId,
    rampBasisPoints: routingOverview?.routing?.rampBasisPoints,
  }}
  onPreview={(change) => previewRoutingChange(client, change)}
  onApply={applyAction}
  onApplied={refresh}
  onClose={() => (routingOpen = false)}
/>

<DrainDialog
  bind:open={drainOpen}
  target={drainTarget}
  routingRole={drainTarget.kind === 'build'
    ? versionRole(overviewOf(drainTarget.deploymentName)?.routing ?? null, drainTarget.buildId)
    : 'none'}
  submitting={drainVersion.isPending}
  onDrain={confirmDrain}
  onCancel={() => (drainOpen = false)}
/>

<ConfirmDialog
  bind:open={removeOpen}
  title="Remove build"
  description={`Marks ${removeTarget.deploymentName}/${removeTarget.buildId} removed so it can no longer be routed to. The server refuses if anything still references it. This cannot be undone.`}
  confirmLabel="Remove build"
  destructive
  typeToConfirm={removeTarget.buildId}
  onConfirm={confirmRemove}
  onCancel={() => (removeOpen = false)}
/>
