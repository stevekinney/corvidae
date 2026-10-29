<script lang="ts">
  /**
   * The stored chunks of one durable stream of a run (COR-1462), opened from the stream's step in
   * the Timeline. The view asks for chunks after the last it holds when the fleet feed announces one
   * (`stream:chunk`, which names the run and the key and carries no body), so a stream being written
   * appears as it grows. While the feed is not live and the run is not terminal it asks every two
   * seconds instead; it stops polling once the run is terminal, and when it is closed. The feed never
   * announces the `tokens` key, which reaches a run's page another way, so a view of it relies on the
   * timer alone.
   *
   * An empty stream says why. A cancelled or timed-out run has its stream chunks swept, so an empty
   * stream there reads "no longer kept"; any other run simply has none yet.
   *
   * Without the feed, a stream written in the seconds between the last poll and the run turning
   * terminal can show a short tail until the view is reopened: no poll is made once the run is terminal.
   */
  import { Button, Skeleton } from '@lostgradient/cinder';
  import type { WorkflowStatus } from '@lostgradient/weft';
  import { onDestroy, untrack } from 'svelte';

  import { RUN_DETAIL_COPY } from '../../../../app/copy.ts';
  import {
    getFleetEventSource,
    hasFleetEventSource,
  } from '../../../../app/engine-status.svelte.ts';
  import { useFleetEventsLive } from '../../../../app/live-polling.svelte.ts';
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

  const fleetLive = useFleetEventsLive();
  const fleetSource = hasFleetEventSource() ? getFleetEventSource() : undefined;

  let disposed = false;
  let reading = false;
  let readAgain = false;

  /** Reads the chunks after the last held. One read at a time: a request made meanwhile is one more read after it. */
  async function load(): Promise<void> {
    if (reading) {
      readAgain = true;
      return;
    }
    reading = true;
    try {
      do {
        readAgain = false;
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
      } while (readAgain);
    } finally {
      reading = false;
    }
  }

  // The first read always happens, for a run that is already terminal too. Everything read inside
  // is untracked: the view is keyed by workflow and stream, so nothing here re-runs, and a status
  // change must not trigger a read.
  $effect(() => {
    untrack(() => void load());
    return () => {
      disposed = true;
    };
  });

  // A chunk of this stream was stored, or the feed lost events it retained no longer: read again.
  // The subscription is the shell's one connection; this opens none of its own.
  $effect(() => {
    if (fleetSource === undefined) return;
    return fleetSource.subscribe((frame) => {
      if (frame.kind === 'fleet:gap') {
        void load();
        return;
      }
      if (frame.kind !== 'stream:chunk' || frame.workflowId !== workflowId) return;
      const key: unknown =
        typeof frame.payload === 'object' && frame.payload !== null
          ? Reflect.get(frame.payload, 'key')
          : undefined;
      if (key === streamKey) void load();
    });
  });

  // The timer is the fallback: it runs while the feed is not live and the run can still write. The
  // effect re-runs when either changes, and its cleanup ends the pending timer, so a poll that was
  // scheduled before the feed came back (or the run ended) never fires, and the one that is
  // in flight reschedules nothing.
  $effect(() => {
    if (terminal || fleetLive()) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function schedule(): void {
      // poll-reason: fallback
      timer = setTimeout(() => void poll(), STREAM_POLL_INTERVAL_MS);
    }
    async function poll(): Promise<void> {
      await load();
      if (current && !disposed) schedule();
    }
    schedule();
    return () => {
      current = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  });

  onDestroy(() => {
    disposed = true;
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
    padding: var(--cinder-density-pad-block) var(--cinder-density-pad-inline);
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
    padding: var(--cinder-space-2) var(--cinder-space-2);
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
