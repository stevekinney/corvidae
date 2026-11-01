<script lang="ts">
  /**
   * Checkpoints tab (plan T3.3, §9.2): `GET …/checkpoints` list, select a
   * checkpoint → Replay (read-only) view + Fork dialog, and a "Compare
   * divergence" link once a fork has been created from this session.
   *
   * ## `client.operations[...]` is JSON-RPC-only
   *
   * `weft.workflows.checkpoints.list`/`.get` have a REST binding
   * (`transports.http: true`), but `HttpClient.operations[name](input)`
   * always speaks JSON-RPC over the wire regardless — confirmed against
   * `weft/src/cli/operation-client-runtime.ts`'s module doc ("The HTTP
   * transport speaks JSON-RPC over the wire") — there is no REST fallback
   * to opt into from the console. This didn't work against a real `POST
   * /jsonrpc` in the dev harness at all before
   * `@lostgradient/weft@0.12.0` (weft#710's `serve({ engine })` bug forced
   * `tests/e2e/e2e-server.ts` onto a bare `handleRequest()` workaround, which
   * has no JSON-RPC-over-HTTP route — `serve()`-pipeline-only, per that
   * file's own module doc; fixed upstream #716); verified live post-bump:
   * `weft.workflows.checkpoints.list` round-trips real checkpoint data
   * through `bun run dev:ui-server`. `checkpointsQuery.isError`
   * still renders the real fault treatment rather than folding an error
   * into the empty state (an earlier draft did exactly that and silently
   * mislabeled a 404 as "no checkpoint history retained") — that stays
   * correct for genuine faults, it just isn't the dev harness's steady
   * state anymore.
   */
  import {
    EmptyState,
    ErrorState,
    Segment,
    SegmentedControl,
    Skeleton,
  } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';
  import type { HttpClient } from '@lostgradient/weft';

  import { RETRY_LABEL, RUN_CHECKPOINTS_COPY } from '../../../../app/copy.ts';
  import { FAULT_TREATMENT_TITLE, faultTreatment } from '../../../../lib/faults.ts';
  import { formatBytes, formatRelativeTime } from '../../../../lib/format/index.ts';
  import DivergenceView from './divergence-view.svelte';
  import {
    checkpointsListQueryKey,
    listCheckpoints,
    type CheckpointsOperationsClient,
    type ForkClient,
    type ForkSourceClient,
  } from './checkpoints-data.ts';
  import ForkDialog from './fork-dialog.svelte';
  import type { WorkflowRevisionListClient } from './fork-revision-picker.ts';
  import ReplayView from './replay-view.svelte';

  interface CheckpointsTabProps {
    readonly client: CheckpointsOperationsClient &
      Pick<HttpClient, 'replayTo' | 'getTimeline'> &
      ForkClient &
      ForkSourceClient &
      WorkflowRevisionListClient;
    readonly workflowId: string;
    /** The workflow TYPE this run is — threaded to `ForkDialog`'s revision picker. */
    readonly workflowType: string;
    /** This run's own persisted revision — threaded to `ForkDialog`'s default-retention line. */
    readonly sourceRevision: string | undefined;
  }

  let { client, workflowId, workflowType, sourceRevision }: CheckpointsTabProps = $props();

  const checkpointsQuery = createQuery(() => ({
    queryKey: checkpointsListQueryKey(workflowId),
    queryFn: () => listCheckpoints(client, workflowId),
  }));

  const treatment = $derived(
    checkpointsQuery.isError ? faultTreatment(checkpointsQuery.error) : null,
  );

  let selectedStep = $state<number | null>(null);
  let panel = $state<'replay' | 'fork'>('replay');
  let forkedWorkflowId = $state<string | null>(null);

  function selectCheckpoint(step: number): void {
    selectedStep = step;
    panel = 'replay';
  }
</script>

<div class="weft-checkpoints-tab">
  {#if checkpointsQuery.isPending}
    <Skeleton height="6rem" />
  {:else if treatment}
    <ErrorState
      variant="flat"
      title={FAULT_TREATMENT_TITLE[treatment.kind]}
      description={treatment.message}
      headingLevel={3}
      retryLabel={RETRY_LABEL}
      onRetry={() => void checkpointsQuery.refetch()}
    />
  {:else if (checkpointsQuery.data ?? []).length === 0}
    <EmptyState
      kind="first-use"
      size="compact"
      title={RUN_CHECKPOINTS_COPY.emptyTitle}
      description={RUN_CHECKPOINTS_COPY.emptyDescription}
    />
  {:else}
    <div class="weft-checkpoints-tab__layout">
      <div class="weft-checkpoints-tab__list">
        {#each checkpointsQuery.data ?? [] as checkpoint (checkpoint.step)}
          <button
            type="button"
            class="weft-checkpoints-tab__row"
            aria-pressed={selectedStep === checkpoint.step}
            onclick={() => selectCheckpoint(checkpoint.step)}
          >
            <span class="weft-checkpoints-tab__row-step">step {checkpoint.step}</span>
            <span class="weft-checkpoints-tab__row-time"
              >{formatRelativeTime(checkpoint.timestamp)}</span
            >
            <span class="weft-checkpoints-tab__row-size">{formatBytes(checkpoint.sizeBytes)}</span>
          </button>
        {/each}
      </div>

      <div class="weft-checkpoints-tab__detail">
        {#if selectedStep === null}
          <EmptyState
            kind="first-use"
            size="compact"
            title={RUN_CHECKPOINTS_COPY.chooseTitle}
            description={RUN_CHECKPOINTS_COPY.chooseDescription}
          />
        {:else}
          <div class="weft-checkpoints-tab__mode">
            <SegmentedControl
              id={`checkpoint-mode-${workflowId}`}
              label={RUN_CHECKPOINTS_COPY.modeLabel}
              labelVisible={false}
              density="toolbar"
              value={panel}
              onValueChange={(next: 'replay' | 'fork') => (panel = next)}
            >
              <Segment value="replay">{RUN_CHECKPOINTS_COPY.replay}</Segment>
              <Segment value="fork">{RUN_CHECKPOINTS_COPY.fork}</Segment>
            </SegmentedControl>
          </div>

          {#if panel === 'replay'}
            <ReplayView {client} {workflowId} step={selectedStep} />
          {:else}
            <ForkDialog
              {client}
              {workflowId}
              initialStep={selectedStep}
              {workflowType}
              {sourceRevision}
              onForked={(id) => (forkedWorkflowId = id)}
            />
          {/if}
        {/if}
      </div>
    </div>

    {#if forkedWorkflowId !== null}
      <div class="weft-checkpoints-tab__divergence">
        <div class="weft-checkpoints-tab__divergence-label">
          {RUN_CHECKPOINTS_COPY.divergenceLabel}
        </div>
        <DivergenceView {client} originalWorkflowId={workflowId} {forkedWorkflowId} />
      </div>
    {/if}
  {/if}
</div>

<style>
  .weft-checkpoints-tab__layout {
    display: grid;
    grid-template-columns: minmax(200px, 260px) 1fr;
    gap: 16px;
    align-items: start;
  }

  @media (max-width: 900px) {
    .weft-checkpoints-tab__layout {
      grid-template-columns: 1fr;
    }
  }

  .weft-checkpoints-tab__list {
    display: flex;
    flex-direction: column;
    gap: 3px;
    background: var(--cinder-surface-raised);
    border: 1px solid var(--cinder-border);
    border-radius: var(--cinder-radius-lg);
    padding: var(--cinder-space-2);
    max-height: 420px;
    overflow-y: auto;
  }

  .weft-checkpoints-tab__row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-height: 40px;
    padding: var(--cinder-space-2) var(--cinder-space-2);
    background: transparent;
    border: 0;
    border-radius: var(--cinder-radius-md);
    font: inherit;
    color: inherit;
    cursor: pointer;
    text-align: left;
  }

  @media (hover: hover) {
    .weft-checkpoints-tab__row:hover {
      background: var(--cinder-surface-hover);
    }
  }

  .weft-checkpoints-tab__row[aria-pressed='true'] {
    background: var(--cinder-surface-hover);
  }

  .weft-checkpoints-tab__row-step {
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-xs);
    flex: 1;
  }

  .weft-checkpoints-tab__row-time,
  .weft-checkpoints-tab__row-size {
    font-size: var(--cinder-text-2xs);
    color: var(--cinder-text-subtle);
  }

  .weft-checkpoints-tab__detail {
    min-width: 0;
  }

  .weft-checkpoints-tab__mode {
    margin-block-end: var(--cinder-space-3);
  }

  .weft-checkpoints-tab__divergence {
    margin-top: 20px;
  }

  .weft-checkpoints-tab__divergence-label {
    font-size: var(--cinder-text-xs);
    font-weight: 600;
    margin-bottom: 8px;
  }
</style>
