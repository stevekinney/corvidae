<script lang="ts">
  /**
   * Replay read-only view (plan T3.3): one notice, a Cinder Alert inside the frame, says this is a
   * replay and changes nothing; the frame has no colored edge. Reconstructs historical state via
   * `client.replayTo` — a side-effecting READ (`weft.workflows.replay`, `workflows:read` scope),
   * never mutates the live workflow.
   */
  import {
    Alert,
    DescriptionList,
    EmptyState,
    PayloadInspector,
    Skeleton,
  } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';
  import type { HttpClient } from '@lostgradient/weft';
  import { Rewind } from '@lucide/svelte';

  import { RUN_CHECKPOINTS_COPY } from '../../../../app/copy.ts';
  import { getPrincipalStore, scopeGate } from '../../../../lib/scopes.svelte.ts';
  import { formatBytes } from '../../../../lib/format/index.ts';
  import { EAGER_REVISION_HEDGE } from '../../../../lib/workflow-revision.ts';
  import { replayQueryKey, replayWorkflow } from './checkpoints-data.ts';

  interface ReplayViewProps {
    readonly client: Pick<HttpClient, 'replayTo'>;
    readonly workflowId: string;
    readonly step: number;
  }

  let { client, workflowId, step }: ReplayViewProps = $props();

  const principalStore = getPrincipalStore();
  const gate = $derived(scopeGate(principalStore, ['workflows:read']));

  /** Whether a stored value holds nothing, which the inspector would draw as an empty box that scrolls. */
  function isEmptyValue(value: unknown): boolean {
    if (value === null || value === undefined) return true;
    if (Array.isArray(value)) return value.length === 0;
    return typeof value === 'object' && Object.keys(value).length === 0;
  }

  const replayQuery = createQuery(() => ({
    queryKey: replayQueryKey(workflowId, step),
    queryFn: () => replayWorkflow(client, workflowId, step),
    enabled: !gate.disabled,
  }));
</script>

<div class="weft-replay-view">
  {#if gate.disabled}
    <EmptyState
      kind="first-use"
      size="compact"
      title={RUN_CHECKPOINTS_COPY.replayLockedTitle}
      description={gate.title ?? ''}
    />
  {:else}
    <Alert variant="info">
      {#snippet icon()}<Rewind aria-hidden="true" size={14} />{/snippet}
      {RUN_CHECKPOINTS_COPY.replayNotice(step)}
    </Alert>

    {#if replayQuery.isPending}
      <Skeleton height="6rem" />
    {:else if replayQuery.data === null}
      <EmptyState
        kind="first-use"
        size="compact"
        title={RUN_CHECKPOINTS_COPY.replayNoneTitle}
        description={RUN_CHECKPOINTS_COPY.replayNoneDescription(step)}
      />
    {:else if replayQuery.data}
      {@const replay = replayQuery.data}
      <div class="weft-replay-view__body">
        <DescriptionList
          items={[
            { term: 'Version', definition: replay.checkpoint.version },
            {
              term: 'Revision',
              definition:
                replay.revision !== undefined
                  ? `${replay.revision}. ${EAGER_REVISION_HEDGE}`
                  : RUN_CHECKPOINTS_COPY.revisionUnknown,
            },
            { term: 'Recorded', definition: new Date(replay.checkpoint.createdAt).toISOString() },
            { term: 'Events at this step', definition: String(replay.events.length) },
            ...(replay.compactedBefore !== undefined
              ? [
                  {
                    term: 'Compacted',
                    definition: RUN_CHECKPOINTS_COPY.compacted(replay.compactedBefore),
                  },
                ]
              : []),
          ]}
        />
        <div class="weft-replay-view__section">
          <div class="weft-replay-view__section-label">Local state</div>
          {#if isEmptyValue(replay.checkpoint.locals)}
            <p class="weft-replay-view__none">{RUN_CHECKPOINTS_COPY.nothingStored}</p>
          {:else}
            <PayloadInspector
              value={replay.checkpoint.locals}
              label="Checkpoint locals"
              view="json"
            />
          {/if}
        </div>
        <div class="weft-replay-view__section">
          <div class="weft-replay-view__section-label">
            Accumulated results
            <span class="weft-replay-view__section-meta">
              {formatBytes(JSON.stringify(replay.accumulatedResults).length)}
            </span>
          </div>
          {#if isEmptyValue(replay.accumulatedResults)}
            <p class="weft-replay-view__none">{RUN_CHECKPOINTS_COPY.nothingStored}</p>
          {:else}
            <PayloadInspector
              value={replay.accumulatedResults}
              label="Accumulated results"
              view="json"
            />
          {/if}
        </div>
      </div>
    {/if}
  {/if}
</div>

<style>
  .weft-replay-view {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-width: 0;
    background: var(--cinder-surface-raised);
    border: 1px solid var(--cinder-border);
    border-radius: var(--cinder-radius-lg);
    padding: var(--cinder-space-3);
    overflow: hidden;
  }

  .weft-replay-view__body {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
    min-width: 0;
  }

  .weft-replay-view__section {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    min-width: 0;
  }

  .weft-replay-view__section-label {
    font-size: var(--cinder-text-2xs);
    font-weight: 700;
    color: var(--cinder-text-disabled);
  }

  .weft-replay-view__none {
    margin: 0;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-subtle);
  }

  .weft-replay-view__section-meta {
    font-weight: 400;
    margin-inline-start: var(--cinder-space-2);
  }
</style>
