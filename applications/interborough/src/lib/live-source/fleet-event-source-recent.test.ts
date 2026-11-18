/**
 * `FleetEventSource.recent`: the latest frames the source dispatched, kept so a view that opens
 * after the feed has been running starts from what it missed instead of from nothing.
 */
import { waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { installFetchImplementation } from './fetch.test-support.ts';
import {
  FleetEventSource,
  RECENT_FRAME_CAP,
  type FleetEventFrame,
} from './fleet-event-source.svelte.ts';

let restoreFetch: (() => void) | undefined;

afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
});

function frame(sequence: number): FleetEventFrame {
  return {
    kind: 'workflow:completed',
    workflowId: `wf_${String(sequence)}`,
    sequence,
    cursor: String(sequence),
    emittedAtMs: sequence,
    payload: {},
  };
}

/** Serves one open stream that carries `count` frames, then stays open until the source aborts it. */
function serveFrames(count: number): void {
  restoreFetch = installFetchImplementation(async (_input, init) => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let sequence = 1; sequence <= count; sequence += 1) {
          const envelope = frame(sequence);
          controller.enqueue(
            encoder.encode(
              `id: ${envelope.cursor}\nevent: ${envelope.kind}\ndata: ${JSON.stringify(envelope)}\n\n`,
            ),
          );
        }
        init?.signal?.addEventListener('abort', () => controller.close(), { once: true });
      },
    });
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  });
}

describe('FleetEventSource.recent', () => {
  test('is empty before any frame arrives', () => {
    serveFrames(0);
    const source = new FleetEventSource({ baseUrl: '' });
    expect(source.recent()).toEqual([]);
    source.close();
  });

  test('keeps the frames a subscriber saw, oldest first, for a view that opens later', async () => {
    serveFrames(3);
    const source = new FleetEventSource({ baseUrl: '' });
    const seen: FleetEventFrame[] = [];
    const unsubscribe = source.subscribe((received) => seen.push(received));
    await waitFor(() => expect(seen).toHaveLength(3));

    expect(source.recent().map((entry) => entry.sequence)).toEqual([1, 2, 3]);
    expect(source.recent(2).map((entry) => entry.sequence)).toEqual([2, 3]);
    expect(source.recent(0)).toEqual([]);
    unsubscribe();
    source.close();
  });

  // COR-2227: Home's Workflow activity offers Try again when its first window cannot be read.
  test('retryNow connects at once when a reconnect is waiting out its backoff', async () => {
    let requests = 0;
    restoreFetch = installFetchImplementation(async () => {
      requests += 1;
      return new Response('down', { status: 503 });
    });
    const source = new FleetEventSource({ baseUrl: '', computeReconnectDelayMs: () => 1_000_000 });
    const unsubscribe = source.subscribe(() => {});
    await waitFor(() => expect(source.reconnectAttempt).toBe(1));
    expect(source.status).toBe('reconnecting');
    source.retryNow();
    await waitFor(() => expect(source.reconnectAttempt).toBe(2));
    expect(requests).toBe(2);
    unsubscribe();
    source.close();
  });

  test('failedConnections counts every failure and drop, and a ping that resets the attempt never lowers it', async () => {
    const encoder = new TextEncoder();
    let requests = 0;
    let open: ReadableStreamDefaultController<Uint8Array> | undefined;
    restoreFetch = installFetchImplementation(async () => {
      requests += 1;
      if (requests === 1) return new Response('down', { status: 503 });
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          open = controller;
        },
      });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    });
    const source = new FleetEventSource({ baseUrl: '', computeReconnectDelayMs: () => 1_000_000 });
    const unsubscribe = source.subscribe(() => {});
    await waitFor(() => expect(source.failedConnections).toBe(1));
    expect(source.reconnectAttempt).toBe(1);
    source.retryNow();
    await waitFor(() => expect(open).toBeDefined());
    // The connection answers (a ping, not the end of the replay), so the attempt starts again at 0.
    open?.enqueue(encoder.encode('event: ping\ndata: {"emittedAtMs":0}\n\n'));
    await waitFor(() => expect(source.reconnectAttempt).toBe(0));
    expect(source.failedConnections).toBe(1);
    // Then it drops: the attempt is 1 again, as it was before, and the failures are 2.
    open?.close();
    await waitFor(() => expect(source.failedConnections).toBe(2));
    expect(source.reconnectAttempt).toBe(1);
    unsubscribe();
    source.close();
  });

  test('holds no more than the cap, dropping the oldest', async () => {
    serveFrames(RECENT_FRAME_CAP + 5);
    const source = new FleetEventSource({ baseUrl: '' });
    const seen: FleetEventFrame[] = [];
    const unsubscribe = source.subscribe((received) => seen.push(received));
    await waitFor(() => expect(seen).toHaveLength(RECENT_FRAME_CAP + 5));

    const recent = source.recent();
    expect(recent).toHaveLength(RECENT_FRAME_CAP);
    expect(recent[0]?.sequence).toBe(6);
    expect(recent.at(-1)?.sequence).toBe(RECENT_FRAME_CAP + 5);
    unsubscribe();
    source.close();
  });
});
