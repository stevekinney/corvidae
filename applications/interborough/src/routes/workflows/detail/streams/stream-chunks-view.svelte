<script lang="ts">
  /**
   * The stored chunks of one durable stream of a run (COR-1462), opened from the stream's step in
   * the Timeline. While the run is not terminal the view asks for chunks after the last it holds every
   * two seconds, so a stream being written appears as it grows; it stops once the run is terminal,
   * and when it is closed.
   *
   * An empty stream says why. A cancelled or timed-out run has its stream chunks swept, so an empty
   * stream there reads "no longer kept"; any other run simply has none yet.
   *
   * A stream written in the seconds between the last poll and the run turning terminal can show a
   * short tail until the view is reopened: nothing is requested once the run is terminal.
   */
  import { Button, Skeleton } from '@lostgradient/cinder';
  import type { WorkflowStatus } from '@lostgradient/weft';
  import { onDestroy, untrack } from 'svelte';

  import { RUN_DETAIL_COPY } from '../../../../app/copy.ts';
  import { faultTreatment, type FaultTreatment } from '../../../../lib/faults.ts';
  import RunFaultBanner from '../run-fault-banner.svelte';
  import { isTerminalStatus } from '../workflow-status.ts';
  import {
    appendNewChunks,
    displayStreamKey,
    readStreamChunks,
    STREAM_POLL_INTERVAL_MS,
    streamChunksAreSwept,
    type StreamChunk,
    type StreamChunksClient,
  } from './stream-chunks-data.ts';

  interface StreamChunksViewProps {
    readonly client: StreamChunksClient;
    readonly workflowId: string;
    readonly streamKey: string;
    /** The run's status: it decides whether to keep polling and what an empty stream says. */
    readonly status: WorkflowStatus;
    readonly onClose: () => void;
  }

  let { client, workflowId, streamKey, status, onClose }: StreamChunksViewProps = $props();

  const copy = RUN_DETAIL_COPY.streams;

  let chunks = $state<readonly StreamChunk[]>([]);
  let loaded = $state(false);
  let fault = $state<FaultTreatment | null>(null);

  const terminal = $derived(isTerminalStatus(status));
  const swept = $derived(streamChunksAreSwept(status));
  const keyLabel = $derived(displayStreamKey(streamKey, copy.keyDisplayLimit));
  const viewState = $derived(
    chunks.length > 0 ? 'ready' : fault !== null ? 'error' : loaded ? 'empty' : 'loading',
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  function stopPolling(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  async function load(): Promise<void> {
    try {
      const incoming = await readStreamChunks(
        client,
        workflowId,
        streamKey,
        chunks.at(-1)?.sequence,
      );
      if (disposed) return;
      chunks = appendNewChunks(chunks, incoming);
      fault = null;
      loaded = true;
    } catch (error) {
      if (disposed) return;
      // Keep what is held: a fault on one poll does not take back the chunks already shown, and a
      // view that has read nothing yet is a fault, not an empty stream.
      fault = faultTreatment(error);
    }
  }

  async function poll(): Promise<void> {
    await load();
    if (disposed || terminal) return;
    timer = setTimeout(() => void poll(), STREAM_POLL_INTERVAL_MS);
  }

  // The first read always happens, for a run that is already terminal too; polling is only for a
  // run that can still write. Everything read inside is untracked: the view is keyed by workflow and
  // stream, so nothing here re-runs, and a status change must not trigger a read.
  $effect(() => {
    untrack(() => void poll());
    return () => {
      disposed = true;
      stopPolling();
    };
  });

  // A run that turns terminal between polls: the pending poll is cancelled, not run.
  $effect(() => {
    if (terminal) stopPolling();
  });

  onDestroy(() => {
    disposed = true;
    stopPolling();
  });
</script>

<section
  class="weft-stream-view"
  aria-label={`${copy.heading}: ${streamKey}`}
  data-state={viewState}
>
  <header class="weft-stream-view__header">
    <h3 class="weft-stream-view__heading">{copy.heading}</h3>
    <code
      class="weft-stream-view__key"
      data-stream-key
      title={keyLabel.truncated ? streamKey : undefined}>{keyLabel.text}</code
    >
    <Button variant="ghost" size="sm" label={copy.close} onclick={onClose} />
  </header>

  {#if fault !== null}
    <RunFaultBanner treatment={fault} />
  {/if}

  {#if chunks.length > 0}
    <ol class="weft-stream-view__chunks">
      {#each chunks as chunk (chunk.sequence)}
        <li class="weft-stream-view__chunk" data-chunk-sequence={chunk.sequence}>
          <span class="weft-stream-view__sequence">{copy.chunkLabel(chunk.sequence)}</span>
          <pre class="weft-stream-view__value">{typeof chunk.value === 'string'
              ? chunk.value
              : JSON.stringify(chunk.value, null, 2)}</pre>
        </li>
      {/each}
    </ol>
    {#if !terminal}
      <p class="weft-stream-view__note">{copy.liveNote}</p>
    {/if}
  {:else if loaded}
    <p class="weft-stream-view__empty">{swept ? copy.swept : copy.noChunks}</p>
    {#if !terminal}
      <p class="weft-stream-view__note">{copy.liveNote}</p>
    {/if}
  {:else if fault === null}
    <div aria-busy="true" aria-label={copy.loading}><Skeleton height="3rem" /></div>
  {/if}
</section>

<style>
  .weft-stream-view {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px 15px;
    background: var(--cinder-surface-raised);
    border: 1px solid var(--cinder-border);
    border-radius: var(--cinder-radius-lg);
  }

  .weft-stream-view__header {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  .weft-stream-view__heading {
    margin: 0;
    font-size: var(--cinder-text-sm);
    font-weight: 600;
  }

  .weft-stream-view__key {
    flex: 1 1 auto;
    min-width: 0;
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-xs);
    color: var(--cinder-text-subtle);
    overflow-wrap: anywhere;
  }

  .weft-stream-view__chunks {
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .weft-stream-view__chunk {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .weft-stream-view__sequence {
    font-size: var(--cinder-text-2xs);
    color: var(--cinder-text-subtle);
  }

  .weft-stream-view__value {
    margin: 0;
    padding: 6px 8px;
    background: var(--cinder-surface-inset);
    border-radius: var(--cinder-radius-md);
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-xs);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .weft-stream-view__empty,
  .weft-stream-view__note {
    margin: 0;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-subtle);
  }

  .weft-stream-view__note {
    font-size: var(--cinder-text-2xs);
  }
</style>
