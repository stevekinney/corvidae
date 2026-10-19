<script lang="ts">
  /**
   * The worker binding section of the restart dialog (COR-164): says which
   * build the restarted run will keep, and, for a terminal auto-upgrade run,
   * offers the preview-then-spend override.
   *
   * ## The flow
   *
   * A restart inherits the terminal run's current binding
   * (`WORKER_INHERITANCE_RULES.restart`). To move the replacement to the build
   * routing selects now, an operator with `system:admin` asks the server for a
   * preview (`weft.worker.startoverrides.preview`), reads what it would change,
   * and ticks the confirmation. Only then does `confirmed` carry the
   * server-issued token up to the dialog, which spends it on the restart. There
   * is no path from here to a start without that token, and no in-place
   * "upgrade this running workflow" action: a run that is not terminal and
   * auto-upgrade gets the reason it cannot be overridden instead of a button.
   *
   * The server stays authoritative. It re-checks terminal status, policy,
   * routing, and compatibility when it issues the preview, and again when the
   * start spends it; this component only decides whether the action is worth
   * offering, and shows the typed fault when the server disagrees.
   */
  import { Button, Checkbox, DescriptionList, Tooltip } from '@lostgradient/cinder';
  import { createMutation } from '@tanstack/svelte-query';
  import type { WorkerStartOverridePreview, WorkflowState } from '@lostgradient/weft';
  import { onDestroy } from 'svelte';

  import { formatRelativeTime } from '../../../lib/format/index.ts';
  import { getPrincipalStore, scopeGate } from '../../../lib/scopes.svelte.ts';
  import WorkerInheritanceNote from '../../../lib/worker-inheritance-note.svelte';
  import {
    explainWorkerBinding,
    overrideEligibility,
    readWorkflowWorkerState,
  } from '../../../lib/workflow-worker-binding.ts';
  import { TickingClock } from './ticking-clock.svelte.ts';
  import { describeOverrideFault, type WorkerOverrideClient } from './worker-override.ts';

  interface RestartWorkerOverrideProps {
    readonly client: WorkerOverrideClient;
    readonly workflow: WorkflowState;
    /** The confirmed, unexpired preview the restart should spend; `undefined` means a plain restart. */
    confirmed: WorkerStartOverridePreview | undefined;
    /** True once the start refused the token, so the issued preview is dropped and a new one is needed. */
    readonly tokenRejected: boolean;
    /** Fired when a new preview is requested, so the dialog can clear the previous start's error. */
    readonly onRequested?: (() => void) | undefined;
  }

  let {
    client,
    workflow,
    confirmed = $bindable(),
    tokenRejected,
    onRequested,
  }: RestartWorkerOverrideProps = $props();

  const principal = getPrincipalStore();
  const adminGate = $derived(scopeGate(principal, ['system:admin']));

  const reading = $derived(readWorkflowWorkerState(workflow));
  const eligibility = $derived(overrideEligibility(reading, workflow.status));

  let issued = $state<WorkerStartOverridePreview | undefined>();
  let confirmedByOperator = $state(false);

  const clock = new TickingClock();
  onDestroy(() => clock.dispose());
  // Reading `clock.now` makes this re-evaluate every second; `Date.now()` keeps a
  // preview that arrives already past its expiry from looking valid until the next tick.
  const expired = $derived.by(() => {
    void clock.now;
    return issued !== undefined && Date.now() >= issued.expiresAt;
  });

  const previewMutation = createMutation(() => ({
    mutationFn: async () => {
      const preview = client.operations['weft.worker.startoverrides.preview'];
      if (preview === undefined) throw new Error('This client cannot request an override preview.');
      const issuedPreview = await preview({ workflowId: workflow.id });
      return issuedPreview.preview;
    },
    onSuccess: (preview) => {
      // The preview is bound to the run it was requested for. One issued for another run, a
      // completion that outlived the dialog it was asked from, is dropped rather than shown here.
      if (preview.workflowId !== workflow.id) return;
      issued = preview;
      confirmedByOperator = false;
    },
  }));

  function requestPreview(): void {
    if (previewMutation.isPending) return;
    issued = undefined;
    confirmedByOperator = false;
    onRequested?.();
    previewMutation.mutate();
  }

  $effect(() => {
    confirmed = issued !== undefined && confirmedByOperator && !expired ? issued : undefined;
  });

  $effect(() => {
    if (tokenRejected) {
      issued = undefined;
      confirmedByOperator = false;
    }
  });

  const previewItems = $derived(
    issued === undefined
      ? []
      : [
          {
            id: 'generation',
            term: 'Routing generation',
            definition: `${issued.previousRoutingGeneration} → ${issued.targetRoutingGeneration}`,
          },
          {
            id: 'workflow-contract',
            term: 'Target workflow contract',
            definition: issued.targetWorkflowContractHash,
          },
          {
            id: 'activity-contracts',
            term: 'Target activity contracts',
            definition: issued.targetActivityContractsDigest,
          },
          {
            id: 'expires',
            term: 'Valid until',
            definition: `${new Date(issued.expiresAt).toISOString()} (${formatRelativeTime(issued.expiresAt)})`,
          },
        ],
  );
</script>

{#if reading.kind !== 'absent'}
  <section class="weft-restart-override" data-testid="restart-worker-override">
    <h3 class="weft-restart-override__title">Worker binding</h3>
    {#if reading.kind === 'bound'}
      <p>{explainWorkerBinding(reading)}</p>
    {/if}
    <WorkerInheritanceNote surface="restart" />

    {#if !eligibility.eligible}
      <p class="weft-restart-override__reason" data-testid="restart-override-reason">
        {eligibility.reason}
      </p>
    {:else}
      <div class="weft-restart-override__actions">
        <Tooltip text={adminGate.title ?? ''}>
          <Button
            variant="secondary"
            size="sm"
            onclick={requestPreview}
            loading={previewMutation.isPending}
            disabled={adminGate.disabled}
          >
            Preview worker upgrade
          </Button>
        </Tooltip>
        {#if adminGate.disabled}
          <span class="weft-restart-override__reason">
            Previewing a worker override needs the system:admin scope.
          </span>
        {/if}
      </div>

      {#if previewMutation.isError}
        <p class="weft-restart-override__error" role="alert">
          {describeOverrideFault(previewMutation.error)}
        </p>
      {/if}

      {#if tokenRejected}
        <p class="weft-restart-override__error" role="alert">
          The start refused the override preview, so it was dropped. Request a new preview to try
          again, or restart on the inherited build.
        </p>
      {/if}

      {#if issued !== undefined}
        <div class="weft-restart-override__preview" role="status">
          <DescriptionList items={previewItems} variant="default" />
          {#if expired}
            <p class="weft-restart-override__error">
              This preview has expired. Request a new one to use the override.
            </p>
          {:else}
            <Checkbox
              id="weft-restart-override-confirm"
              label="Restart on the build routing selects now"
              description="Spends this single-use preview. Leave it unticked to restart on the inherited build."
              bind:checked={confirmedByOperator}
            />
          {/if}
        </div>
      {/if}
    {/if}
  </section>
{/if}

<style>
  .weft-restart-override {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 12px;
    border: 1px solid var(--cinder-border);
    border-radius: var(--cinder-radius-md);
    font-size: var(--cinder-text-xs);
  }

  .weft-restart-override p {
    margin: 0;
  }

  .weft-restart-override__title {
    margin: 0;
    font-size: var(--cinder-text-sm);
  }

  .weft-restart-override__actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  .weft-restart-override__reason {
    color: var(--cinder-text-subtle);
  }

  .weft-restart-override__error {
    color: var(--cinder-status-danger-text);
  }

  .weft-restart-override__preview {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
</style>
