<script lang="ts">
  /**
   * Preview, confirm, apply (COR-277): the one flow behind set-routing,
   * promote, and rollback. Nothing is applied from a form submit. The dialog
   * first asks the server to preview the change (`weft.worker.deployments.preview`),
   * which validates the builds and reports the routing generation as it stands;
   * only then does it offer a confirmation, and the change is applied with that
   * generation as `expectedGeneration`. A pointer that moved in the meantime is
   * refused by the server with a typed stale-generation Conflict, which this
   * dialog names separately from every other fault and answers with a fresh
   * preview, never a silent retry.
   */
  import { Alert, Button, Modal, NumberInput, Select, Skeleton } from '@lostgradient/cinder';
  import type { WorkerDeploymentVersion } from '@lostgradient/weft';
  import { untrack } from 'svelte';

  import { faultTreatment } from '../../lib/faults.ts';
  import {
    staleGenerationOf,
    type PreviewResult,
    type RoutingAction,
    type RoutingChange,
  } from './deployments-data.ts';
  import { formatBasisPoints } from './deployments-presentation.ts';

  export type RoutingDialogRequest =
    | { readonly kind: 'setrouting'; readonly deploymentName: string }
    | {
        readonly kind: 'promote' | 'rollback';
        readonly deploymentName: string;
        readonly buildId: string;
      };

  interface RoutingDialogProps {
    readonly open: boolean;
    readonly request: RoutingDialogRequest;
    /** The deployment's builds, for the set-routing form. */
    readonly versions: readonly WorkerDeploymentVersion[];
    /** The pointer's current values, to start the set-routing form from. */
    readonly initial: {
      readonly currentBuildId?: string | undefined;
      readonly rampingBuildId?: string | undefined;
      readonly rampBasisPoints?: number | undefined;
    };
    readonly onPreview: (change: RoutingChange) => Promise<PreviewResult>;
    readonly onApply: (action: RoutingAction, expectedGeneration: number) => Promise<unknown>;
    /** Called once a change is applied. */
    readonly onApplied: () => void;
    readonly onClose: () => void;
  }

  let {
    open = $bindable(),
    request,
    versions,
    initial,
    onPreview,
    onApply,
    onApplied,
    onClose,
  }: RoutingDialogProps = $props();

  const NO_RAMP = '';
  const readyVersions = $derived(versions.filter((version) => version.state === 'ready'));
  const buildOptions = $derived(
    readyVersions.map((version) => ({ value: version.buildId, label: version.buildId })),
  );
  const rampOptions = $derived([{ value: NO_RAMP, label: 'No ramping build' }, ...buildOptions]);

  let currentBuildId = $state('');
  let rampingBuildId = $state(NO_RAMP);
  let rampPercent = $state<number | null>(0);

  type Step =
    | { readonly kind: 'form' }
    | { readonly kind: 'previewing' }
    | {
        readonly kind: 'confirm';
        readonly preview: PreviewResult;
        readonly action: RoutingAction;
        readonly change: RoutingChange;
      }
    | { readonly kind: 'applying' }
    | { readonly kind: 'stale'; readonly currentGeneration: number }
    | { readonly kind: 'failed'; readonly error: unknown };

  let step = $state<Step>({ kind: 'form' });

  function changeFor(): RoutingChange {
    if (request.kind === 'setrouting') {
      return {
        deploymentName: request.deploymentName,
        currentBuildId,
        ...(rampingBuildId === NO_RAMP ? {} : { rampingBuildId }),
        rampBasisPoints: Math.round((rampPercent ?? 0) * 100),
      };
    }
    return {
      deploymentName: request.deploymentName,
      currentBuildId: request.buildId,
      rampBasisPoints: 10_000,
    };
  }

  function actionFor(change: RoutingChange): RoutingAction {
    return request.kind === 'setrouting'
      ? { kind: 'setrouting', change }
      : { kind: request.kind, deploymentName: request.deploymentName, buildId: request.buildId };
  }

  async function preview(): Promise<void> {
    step = { kind: 'previewing' };
    const change = changeFor();
    try {
      const result = await onPreview(change);
      step = { kind: 'confirm', preview: result, action: actionFor(change), change };
    } catch (error) {
      step = { kind: 'failed', error };
    }
  }

  async function confirm(): Promise<void> {
    if (step.kind !== 'confirm') return;
    const { action, preview: previewed } = step;
    step = { kind: 'applying' };
    try {
      await onApply(action, previewed.currentGeneration);
      open = false;
      onApplied();
    } catch (error) {
      const generation = staleGenerationOf(error);
      step =
        generation === undefined
          ? { kind: 'failed', error }
          : { kind: 'stale', currentGeneration: generation };
    }
  }

  // Each opening starts over: the form from the pointer's values, a promote or rollback straight to
  // its preview. Only `open` is tracked, so the 30 second refresh of the builds never resets a form
  // the operator is editing.
  $effect(() => {
    if (!open) return;
    untrack(() => {
      currentBuildId = initial.currentBuildId ?? readyVersions[0]?.buildId ?? '';
      rampingBuildId = initial.rampingBuildId ?? NO_RAMP;
      rampPercent = (initial.rampBasisPoints ?? 0) / 100;
      step = { kind: 'form' };
      if (request.kind !== 'setrouting') void preview();
    });
  });

  function dismiss(): void {
    open = false;
    onClose();
  }

  const TITLE = {
    setrouting: 'Set routing',
    promote: 'Promote build',
    rollback: 'Roll back to build',
  } as const;

  const formInvalid = $derived(
    currentBuildId === '' ||
      rampingBuildId === currentBuildId ||
      rampPercent === null ||
      rampPercent < 0 ||
      rampPercent > 100,
  );

  function describe(change: RoutingChange): string {
    const ramp =
      change.rampingBuildId === undefined
        ? 'no build is ramping'
        : `${formatBasisPoints(change.rampBasisPoints)} of unpinned traffic goes to build ${change.rampingBuildId}`;
    return `Build ${change.currentBuildId} becomes the current build and ${ramp}.`;
  }
</script>

<Modal bind:open title={`${TITLE[request.kind]} · ${request.deploymentName}`} onDismiss={dismiss}>
  {#snippet children()}
    {#if request.kind === 'setrouting' && (step.kind === 'form' || step.kind === 'previewing')}
      <div class="weft-routing-dialog__form">
        <Select
          id="routing-current-build"
          label="Current build"
          description="Receives all unpinned traffic outside the ramp."
          value={currentBuildId}
          onchange={(event) => (currentBuildId = event.currentTarget.value)}
          options={buildOptions}
          disabled={step.kind === 'previewing'}
        />
        <Select
          id="routing-ramping-build"
          label="Ramping build"
          description="Receives the share set below, chosen deterministically per workflow."
          value={rampingBuildId}
          onchange={(event) => (rampingBuildId = event.currentTarget.value)}
          options={rampOptions}
          disabled={step.kind === 'previewing'}
        />
        <NumberInput
          id="routing-ramp-percent"
          label="Traffic to the ramping build"
          adornment="%"
          min={0}
          max={100}
          step={0.01}
          format={{ maximumFractionDigits: 2 }}
          bind:value={rampPercent}
          disabled={step.kind === 'previewing'}
        />
        {#if rampingBuildId === currentBuildId && currentBuildId !== ''}
          <Alert variant="warning">The ramping build must differ from the current build.</Alert>
        {/if}
      </div>
    {/if}

    {#if step.kind === 'previewing'}
      <div role="status" aria-busy="true" aria-label="Previewing routing change">
        <Skeleton height="3rem" />
      </div>
    {:else if step.kind === 'confirm'}
      <Alert variant="success">{step.preview.message}</Alert>
      <p class="weft-routing-dialog__summary">{describe(step.change)}</p>
      <p class="weft-routing-dialog__generation">
        This applies against routing generation {step.preview.currentGeneration}. If the pointer
        changes before you confirm, the server refuses the change.
      </p>
    {:else if step.kind === 'applying'}
      <div role="status" aria-busy="true" aria-label="Applying routing change">
        <Skeleton height="3rem" />
      </div>
    {:else if step.kind === 'stale'}
      <Alert variant="warning"
        >Routing changed since you previewed it: the pointer is now at generation {step.currentGeneration}.
        Nothing was applied. Preview the change again to review it against the current routing.</Alert
      >
    {:else if step.kind === 'failed'}
      {@const treatment = faultTreatment(step.error)}
      <Alert variant="danger">{treatment.message}</Alert>
    {/if}
  {/snippet}
  {#snippet footer()}
    <Button variant="secondary" onclick={dismiss} disabled={step.kind === 'applying'}>Cancel</Button
    >
    {#if step.kind === 'confirm'}
      <Button variant="primary" onclick={confirm}
        >Confirm {TITLE[request.kind].toLowerCase()}</Button
      >
    {:else if step.kind === 'form' && request.kind === 'setrouting'}
      <Button variant="primary" onclick={preview} disabled={formInvalid}>Preview change</Button>
    {:else if step.kind === 'stale' || step.kind === 'failed'}
      <Button variant="primary" onclick={preview}>Preview again</Button>
    {/if}
  {/snippet}
</Modal>
